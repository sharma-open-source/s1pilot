import type { Page } from 'playwright';

export interface StableWaitOptions {
  /** Max time to wait for network idle (default 2000). */
  networkIdleMs?: number;
  /** Required DOM quiet period (default 300). */
  quietMs?: number;
  /** Cap for the DOM quiet wait (default 3000). */
  quietCapMs?: number;
  /** Max time to wait for a visible loading indicator to go away (default {@link BUSY_CAP_MS}). */
  busyCapMs?: number;
}

/** Default cap for {@link waitWhileBusy}. */
export const BUSY_CAP_MS = 10_000;
/** A loader that sits still this long with no request in flight and no page change is treated as static. */
export const BUSY_STATIC_MS = 1000;
const BUSY_POLL_MS = 100;

interface BusyState {
  busy: boolean;
  /** Changes when the indicators or the page content change. */
  sig: string;
}

/**
 * Finds visible loading indicators: an `aria-busy` region, an indeterminate progress bar, a small
 * spinner/loader element, or a short "Loading…" / "Please wait" text. Indicators marked static
 * (`markStatic` on an earlier call, kept until the page navigates) are ignored. Runs in the page.
 */
function pageBusy(markStatic: boolean): BusyState {
  const w = window as unknown as { __s1pilotStaticBusy?: WeakSet<Element> };
  const ignored = (w.__s1pilotStaticBusy ??= new WeakSet());
  /** Shown on screen and at least `min` px each way (screen-reader-only text is 1 px). */
  const shown = (el: Element, min: number): boolean => {
    const r = el.getBoundingClientRect();
    if (r.width < min || r.height < min || r.right <= 0 || r.bottom <= 0) return false;
    return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  const SPINNER_CLASS = /(^|[-_])(spinner|loader)($|[-_])/i;
  const found: Element[] = [];
  for (const el of Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"], progress, [data-loading="true"], [class]'))) {
    if (ignored.has(el)) continue;
    let candidate = false;
    if (el.getAttribute('aria-busy') === 'true' || el.getAttribute('data-loading') === 'true') candidate = shown(el, 8);
    else if (el.getAttribute('role') === 'progressbar') candidate = !el.hasAttribute('aria-valuenow') && !el.hasAttribute('aria-valuetext') && shown(el, 4);
    else if (el.tagName === 'PROGRESS') candidate = !el.hasAttribute('value') && shown(el, 4);
    else if (Array.from(el.classList).some((c) => SPINNER_CLASS.test(c))) {
      // Spinners are small; a big "loader-wrapper" around the content is not one.
      const r = el.getBoundingClientRect();
      candidate = r.width <= 200 && r.height <= 200 && shown(el, 8);
    }
    if (candidate) found.push(el);
  }
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const text = /^(loading|please wait)\s*(\.{0,3}|…)$/i;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const value = node.nodeValue?.trim() ?? '';
      const parent = node.parentElement;
      if (value.length > 0 && value.length <= 16 && text.test(value) && parent && !ignored.has(parent) && shown(parent, 8)) found.push(parent);
    }
  }
  if (markStatic) for (const el of found) ignored.add(el);
  const sig = `${found.length}:${document.getElementsByTagName('*').length}:${document.body?.textContent?.length ?? 0}`;
  return { busy: found.length > 0, sig };
}

/** Requests in flight per page (document, fetch and XHR), from the first {@link trackRequests} call on. */
const inflight = new WeakMap<Page, Set<unknown>>();

/**
 * Starts tracking `page`'s document, fetch and XHR requests (once per page) and returns the set of
 * those still in flight. Call it before an action so {@link waitWhileBusy} sees the requests it starts.
 */
export function trackRequests(page: Page): Set<unknown> {
  let open = inflight.get(page);
  if (open) return open;
  const requests = new Set<unknown>();
  open = requests;
  inflight.set(page, requests);
  const relevant = new Set(['document', 'fetch', 'xhr']);
  page.on('request', (r) => {
    if (relevant.has(r.resourceType())) requests.add(r);
  });
  const done = (r: unknown): void => {
    requests.delete(r);
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return requests;
}

/**
 * Waits while the page shows a loading indicator (see `pageBusy`), up to `capMs`. An indicator that
 * stays put for {@link BUSY_STATIC_MS} with no request in flight and no page change is decoration,
 * not a loader: it is ignored from then on (until the page navigates). Returns whether it waited
 * for a loader that went away. Never throws: navigations and closed pages end the wait.
 */
export async function waitWhileBusy(page: Page, capMs = BUSY_CAP_MS): Promise<boolean> {
  const requests = trackRequests(page);
  const end = Date.now() + capMs;
  let waited = false;
  let lastSig = '';
  let stillSince = Date.now();
  while (Date.now() < end) {
    const state = await page.evaluate(pageBusy, false).catch(() => undefined);
    if (!state?.busy) return waited;
    const now = Date.now();
    if (state.sig !== lastSig || requests.size > 0) {
      lastSig = state.sig;
      stillSince = now;
    } else if (now - stillSince >= BUSY_STATIC_MS) {
      await page.evaluate(pageBusy, true).catch(() => undefined);
      return false;
    }
    waited = true;
    await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_MS));
  }
  // Still busy at the cap: stop re-waiting for the same indicators on this page.
  await page.evaluate(pageBusy, true).catch(() => undefined);
  return false;
}

/**
 * Waits for the page to settle: `domcontentloaded`, network idle (bounded), a DOM quiet period
 * (no mutations for `quietMs`, capped) and no visible loading indicator (`busyCapMs` in total).
 * Never throws; a closed page returns immediately.
 */
export async function waitForStable(page: Page, opts: StableWaitOptions = {}): Promise<void> {
  const { networkIdleMs = 2000, quietMs = 300, quietCapMs = 3000, busyCapMs = BUSY_CAP_MS } = opts;
  const busyEnd = Date.now() + busyCapMs;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: quietCapMs });
    await page.waitForLoadState('networkidle', { timeout: networkIdleMs }).catch(() => undefined);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.evaluate(
          ([quiet, cap]) =>
            new Promise<void>((resolve) => {
              let timer = setTimeout(done, quiet);
              const capTimer = setTimeout(done, cap);
              const mo = new MutationObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(done, quiet);
              });
              mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
              function done(): void {
                mo.disconnect();
                clearTimeout(timer);
                clearTimeout(capTimer);
                resolve();
              }
            }),
          [quietMs, quietCapMs] as const,
        );
        // A loader can sit still (CSS-only spinner): wait for it to go, then let the new content render.
        if (await waitWhileBusy(page, busyEnd - Date.now())) {
          await page.waitForLoadState('domcontentloaded', { timeout: quietCapMs });
          continue;
        }
        return;
      } catch {
        // Execution context destroyed by a navigation: wait for the new document and retry.
        await page.waitForLoadState('domcontentloaded', { timeout: quietCapMs });
      }
    }
  } catch {
    // Page closed or load state never reached: nothing more to wait for.
  }
}
