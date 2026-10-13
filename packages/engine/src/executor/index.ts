import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LocatorCandidate } from '@s1pilot/domain';
import { errors, type Dialog, type Download, type Frame, type Locator, type Page } from 'playwright';

import { toPlaywrightLocator } from '../observer/locators.js';

import { normalizeColor, normalizeRange, rangeBounds, setAriaSlider, type ValueResult } from './input-values.js';
import { dragOnto, uploadVia } from './pointer.js';
import { isTemporalInputType, normalizeTemporal, type TemporalResult } from './temporal.js';
import type {
  ActionError,
  ActionOutcome,
  DialogRecord,
  DownloadRecord,
  EngineAction,
  ExecutorContext,
  NewPageRecord,
  ScrollDirection,
} from './types.js';
import { trackRequests, waitForStable } from './waits.js';

export * from './infer.js';
export * from './types.js';
export * from './waits.js';

const DEFAULT_TIMEOUT_MS = 5000;

/** Internal failure carrying an {@link ActionError}. */
class ExecError extends Error {
  constructor(readonly info: ActionError) {
    super(info.message);
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof errors.TimeoutError) return true;
  const msg = err instanceof Error ? err.message : '';
  return /detached|not attached/i.test(msg);
}

function findScope(page: Page, frame: string | undefined): Page | Frame {
  if (!frame) return page;
  return page.frames().find((f) => f.name() === frame || f.url() === frame) ?? page;
}

/** Locator candidates that currently resolve to exactly one element, in the given order. */
async function uniqueCandidates(
  scope: Page | Frame,
  candidates: readonly LocatorCandidate[],
): Promise<Array<{ candidate: LocatorCandidate; locator: Locator }>> {
  const found: Array<{ candidate: LocatorCandidate; locator: Locator }> = [];
  for (const candidate of candidates) {
    const locator = toPlaywrightLocator(scope, candidate);
    try {
      if ((await locator.count()) === 1) found.push({ candidate, locator });
    } catch {
      // Invalid selector: skip this candidate.
    }
  }
  return found;
}

function scrub(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const s of secrets) if (s.length > 0) out = out.split(s).join('[redacted]');
  return out;
}

/** Scrolls the element (or the page, via its root element) in the given direction. */
async function scroll(target: Locator, dir: ScrollDirection): Promise<void> {
  await target.evaluate((el, d) => {
    const root = el === document.documentElement;
    const node = el as HTMLElement;
    const h = root ? window.innerHeight : node.clientHeight;
    const w = root ? window.innerWidth : node.clientWidth;
    const by = (x: number, y: number): void => (root ? window.scrollBy(x, y) : node.scrollBy(x, y));
    const to = (x: number, y: number): void => (root ? window.scrollTo(x, y) : node.scrollTo(x, y));
    if (d === 'down') by(0, h * 0.8);
    else if (d === 'up') by(0, -h * 0.8);
    else if (d === 'right') by(w * 0.8, 0);
    else if (d === 'left') by(-w * 0.8, 0);
    else if (d === 'top') to(0, 0);
    else to(0, root ? document.documentElement.scrollHeight : node.scrollHeight);
  }, dir);
}

/**
 * Performs an action on the page and reports what happened.
 *
 * Element-targeting actions try the unique-resolving locator candidates in order and retry once
 * with the next candidate on timeout/detached errors. Values are resolved via `ctx.resolveValue`
 * only at the moment of use and never appear in the outcome (only `valueRef`). Popups, dialogs
 * and downloads triggered by the action are recorded; dialogs are auto-accepted unless
 * `ctx.guardDialogs`. Always waits for the page to settle before returning. Never throws.
 */
export async function execute(page: Page, action: EngineAction, ctx: ExecutorContext = {}): Promise<ActionOutcome> {
  const started = performance.now();
  // Count the requests this action starts, so a loader waiting on them is not taken for decoration.
  trackRequests(page);
  const timeout = ctx.actionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startUrl = page.url();
  const secrets: string[] = [];
  let navigated = false;
  let usedLocator: LocatorCandidate | undefined;
  let dialog: DialogRecord | undefined;
  let newPage: NewPageRecord | undefined;
  const downloads: Array<Promise<DownloadRecord | undefined>> = [];
  let error: ActionError | undefined;
  const valueRef =
    'valueRef' in action && action.valueRef ? action.valueRef : action.kind === 'upload' ? action.fileRef : undefined;

  const resolve = async (ref: string): Promise<string> => {
    if (!ctx.resolveValue) {
      throw new ExecError({ code: 'missing_value', message: `No value resolver available for ${ref}` });
    }
    const value = await ctx.resolveValue(ref);
    secrets.push(value);
    return value;
  };

  const onDialog = (d: Dialog): void => {
    const accepted = !ctx.guardDialogs;
    dialog = { type: d.type(), message: d.message(), accepted };
    void (accepted ? d.accept() : d.dismiss()).catch(() => undefined);
  };
  const onDownload = (d: Download): void => {
    downloads.push(
      (async () => {
        try {
          const dir = ctx.downloadDir ?? (await mkdtemp(join(tmpdir(), 's1pilot-dl-')));
          const path = join(dir, `${Date.now()}-${d.suggestedFilename()}`);
          await d.saveAs(path);
          return { suggestedFilename: d.suggestedFilename(), path };
        } catch {
          return undefined;
        }
      })(),
    );
  };
  const onPopup = (p: Page): void => {
    if (!newPage) newPage = { page: p, url: p.url() };
  };
  const onNav = (f: Frame): void => {
    if (f === page.mainFrame()) navigated = true;
  };

  const context = page.context();
  page.on('dialog', onDialog);
  page.on('download', onDownload);
  page.on('framenavigated', onNav);
  context.on('page', onPopup);

  const withTarget = async (
    locators: readonly LocatorCandidate[],
    frame: string | undefined,
    run: (locator: Locator) => Promise<void>,
  ): Promise<void> => {
    const scope = findScope(page, frame);
    const candidates = await uniqueCandidates(scope, locators);
    if (candidates.length === 0) {
      throw new ExecError({ code: 'locator_not_found', message: 'No locator candidate resolved to a unique element' });
    }
    let lastErr: unknown;
    for (const { candidate, locator } of candidates.slice(0, 2)) {
      try {
        await run(locator);
        usedLocator = candidate;
        return;
      } catch (err) {
        lastErr = err;
        if (err instanceof ExecError || !isRetryable(err)) break;
      }
    }
    throw lastErr;
  };

  try {
    switch (action.kind) {
      case 'goto':
        await page.goto(action.url, { timeout: Math.max(timeout, 15000), waitUntil: 'domcontentloaded' });
        break;
      case 'goBack':
        await page.goBack({ timeout: Math.max(timeout, 15000), waitUntil: 'domcontentloaded' });
        break;
      case 'press':
        if (action.locators && action.locators.length > 0) {
          await withTarget(action.locators, action.frame, (l) => l.press(action.key, { timeout }));
        } else {
          await page.keyboard.press(action.key);
        }
        break;
      case 'scroll':
        if (action.dir === 'into-view') {
          if (!action.locators || action.locators.length === 0) {
            throw new ExecError({ code: 'action_failed', message: 'scroll into-view needs a target' });
          }
          await withTarget(action.locators, action.frame, (l) => l.scrollIntoViewIfNeeded({ timeout }));
        } else if (action.locators && action.locators.length > 0) {
          await withTarget(action.locators, action.frame, (l) => scroll(l, action.dir));
        } else {
          await scroll(page.locator(':root'), action.dir);
        }
        break;
      case 'click':
        await withTarget(action.locators, action.frame, (l) => l.click({ timeout }));
        break;
      case 'dblclick':
        await withTarget(action.locators, action.frame, (l) => l.dblclick({ timeout }));
        break;
      case 'rightclick':
        await withTarget(action.locators, action.frame, (l) => l.click({ button: 'right', timeout }));
        break;
      case 'drag': {
        const scope = findScope(page, action.target.frame);
        const targets = await uniqueCandidates(scope, action.target.locators);
        const drop = targets[0];
        if (!drop) {
          throw new ExecError({ code: 'locator_not_found', message: 'No drop target candidate resolved to a unique element' });
        }
        await withTarget(action.locators, action.frame, (l) => dragOnto(page, l, drop.locator, timeout));
        break;
      }
      case 'hover':
        await withTarget(action.locators, action.frame, (l) => l.hover({ timeout }));
        break;
      case 'check':
        await withTarget(action.locators, action.frame, (l) => l.check({ timeout }));
        break;
      case 'uncheck':
        await withTarget(action.locators, action.frame, (l) => l.uncheck({ timeout }));
        break;
      case 'fill':
        await withTarget(action.locators, action.frame, async (l) => {
          const value = await resolve(action.valueRef);
          const kind = await l.evaluate(
            (el) =>
              el.tagName === 'SELECT'
                ? 'select'
                : el.tagName === 'INPUT'
                  ? (el as HTMLInputElement).type
                  : el.getAttribute('role') === 'slider'
                    ? 'aria-slider'
                    : '',
            undefined,
            { timeout },
          );
          const check = (r: ValueResult | TemporalResult): string => {
            if (!r.ok) throw new ExecError({ code: 'action_failed', message: r.message });
            return r.value;
          };
          // `quote:all` resolves to newline-separated values: several options of a multi-select.
          if (kind === 'select') await l.selectOption(value.split('\n').map((label) => ({ label })), { timeout });
          // Date/time, range and colour inputs only accept their machine format, not what the UI shows.
          else if (isTemporalInputType(kind)) await l.fill(check(normalizeTemporal(kind, value)), { timeout });
          else if (kind === 'range') await l.fill(check(normalizeRange(value, await rangeBounds(l, timeout))), { timeout });
          else if (kind === 'color') await l.fill(check(await normalizeColor(l, value, timeout)), { timeout });
          else if (kind === 'aria-slider') check(await setAriaSlider(l, value, timeout));
          else await l.fill(value, { timeout });
        });
        break;
      case 'selectOption':
        await withTarget(action.locators, action.frame, async (l) => {
          if (action.valueRef !== undefined) await l.selectOption((await resolve(action.valueRef)).split('\n'), { timeout });
          else if (action.label !== undefined) await l.selectOption({ label: action.label }, { timeout });
          else throw new ExecError({ code: 'missing_value', message: 'selectOption needs a label or valueRef' });
        });
        break;
      case 'upload':
        await withTarget(action.locators, action.frame, async (l) => {
          await uploadVia(page, l, await resolve(action.fileRef), timeout);
        });
        break;
    }
    await waitForStable(page, ctx.stable);
    if (newPage) {
      await newPage.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
      newPage = { page: newPage.page, url: newPage.page.url() };
    }
  } catch (err) {
    if (err instanceof ExecError) error = err.info;
    else {
      const raw = err instanceof Error ? err.message : String(err);
      const code: ActionError['code'] =
        err instanceof errors.TimeoutError ? 'timeout' : /detached|not attached/i.test(raw) ? 'detached' : 'action_failed';
      error = { code, message: scrub(raw, secrets).split('\n')[0] ?? 'action failed' };
    }
  } finally {
    page.off('dialog', onDialog);
    page.off('download', onDownload);
    page.off('framenavigated', onNav);
    context.off('page', onPopup);
  }

  const settled = (await Promise.all(downloads)).find((d): d is DownloadRecord => d !== undefined);
  if (!navigated && !page.isClosed() && page.url() !== startUrl) navigated = true;

  return {
    ok: error === undefined,
    ...(usedLocator ? { usedLocator } : {}),
    navigated,
    ...(newPage ? { newPage } : {}),
    ...(dialog ? { dialog } : {}),
    ...(settled ? { download: settled } : {}),
    ...(valueRef ? { valueRef } : {}),
    ...(error ? { error } : {}),
    durationMs: Math.round(performance.now() - started),
  };
}
