import type { Assertion } from '@s1pilot/domain';
import type { APIRequestContext, Locator, Page } from 'playwright';

import type { StepCapture } from './capture.js';

/** Context for {@link runAssertion}. */
export interface AssertionContext {
  /** Data captured while the step ran; required for responseStatus / noConsoleErrors / downloadExists. */
  capture?: StepCapture;
  /** Request context for `apiCheck`; defaults to `page.request`. */
  request?: APIRequestContext;
  /** Base URL for relative `apiCheck` URLs; defaults to the page URL. */
  baseUrl?: string;
  /** Auto-wait budget per assertion (default 5000 ms). */
  timeoutMs?: number;
}

/** Outcome of one assertion. */
export interface AssertionResult {
  type: string;
  verdict: 'pass' | 'fail';
  /** Short tag text for the UI, e.g. `url ~ /checkout/payment`. */
  summary: string;
  /** Human-readable explanation; on failure includes expected vs actual. */
  message: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const POLL_MS = 100;

interface Check {
  ok: boolean;
  actual: string;
}

async function poll(timeoutMs: number, fn: () => Promise<Check> | Check): Promise<Check> {
  const end = Date.now() + timeoutMs;
  let last: Check = { ok: false, actual: 'nothing checked' };
  for (;;) {
    try {
      last = await fn();
    } catch (err) {
      last = { ok: false, actual: err instanceof Error ? (err.message.split('\n')[0] ?? 'error') : String(err) };
    }
    if (last.ok || Date.now() >= end) return last;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** Heuristic: a `*`/`?` pattern without regex-only syntax is a glob. */
function looksLikeGlob(pattern: string): boolean {
  return /[*?]/.test(pattern) && !/[\\^$()|[\]+{}]|\.\*|\.\+/.test(pattern);
}

/**
 * Builds a predicate for a pattern that is either a glob (`/checkout/*`, `**` crosses slashes)
 * or a regex source. Falls back to substring matching when it is not a valid regex.
 */
export function patternMatcher(pattern: string): (value: string) => boolean {
  if (looksLikeGlob(pattern)) {
    const src = escapeRegex(pattern)
      .replace(/\*\*/g, '@@GLOBSTAR@@')
      .replace(/\*/g, '[^/]*')
      .replace(/@@GLOBSTAR@@/g, '.*')
      .replace(/\?/g, '.');
    const re = new RegExp(`^${src}$`);
    // Globs match anywhere in a URL when written without a scheme/leading slash anchor issues.
    return (v) => re.test(v);
  }
  try {
    const re = new RegExp(pattern);
    return (v) => re.test(v);
  } catch {
    return (v) => v.includes(pattern);
  }
}

interface Target {
  role?: string | undefined;
  name?: string | undefined;
  text?: string | undefined;
  testId?: string | undefined;
  css?: string | undefined;
}

function hasTarget(t: Target): boolean {
  return Boolean(t.role ?? t.text ?? t.testId ?? t.css);
}

function describeTarget(t: Target): string {
  if (t.testId) return t.testId;
  if (t.role) return t.name ? `${t.role} "${t.name}"` : t.role;
  if (t.text) return `"${t.text}"`;
  return t.css ?? '?';
}

function toLocator(page: Page, t: Target): Locator {
  if (t.role) {
    const loc = page.getByRole(t.role as Parameters<Page['getByRole']>[0], t.name ? { name: t.name } : {});
    return t.text ? loc.filter({ hasText: t.text }) : loc;
  }
  if (t.testId) return page.getByTestId(t.testId);
  if (t.text) return page.getByText(t.text);
  return page.locator(t.css ?? ':root');
}

const q = (s: string): string => JSON.stringify(s);

/**
 * Human-readable one-line summary of an assertion, as shown in UI tags
 * (`url ~ /checkout/payment`, `text(status) ⊇ "1"`).
 */
export function summarizeAssertion(a: Assertion): string {
  switch (a.type) {
    case 'urlMatches':
      return `url ~ ${a.pattern.startsWith('/') ? a.pattern : `/${a.pattern}`}`;
    case 'titleContains':
      return `title ⊇ ${q(a.contains)}`;
    case 'elementVisible':
      return `${a.visible ? 'visible' : 'hidden'}(${describeTarget(a)})`;
    case 'elementText':
      return a.equals !== undefined
        ? `text(${describeTarget(a)}) = ${q(a.equals)}`
        : `text(${describeTarget(a)}) ⊇ ${q(a.contains ?? '')}`;
    case 'elementValue':
      return `value(${describeTarget(a)}) = ${q(a.equals)}`;
    case 'elementCount': {
      const parts: string[] = [];
      if (a.equals !== undefined) parts.push(`= ${a.equals}`);
      if (a.min !== undefined) parts.push(`≥ ${a.min}`);
      if (a.max !== undefined) parts.push(`≤ ${a.max}`);
      return `count(${describeTarget(a)}) ${parts.join(' ') || '≥ 0'}`;
    }
    case 'responseStatus':
      return `response${a.method ? ` ${a.method.toUpperCase()}` : ''} ~ ${a.urlPattern} → ${a.status}`;
    case 'noConsoleErrors':
      return 'no console errors';
    case 'downloadExists':
      return a.filenamePattern ? `download ~ ${a.filenamePattern}` : 'download exists';
    case 'apiCheck':
      return `api ${a.method} ${a.url}${a.status !== undefined ? ` → ${a.status}` : ''}${a.bodyContains ? ` ⊇ ${q(a.bodyContains)}` : ''}`;
    case 'ai':
      return `AI: ${a.expected}`;
  }
}

function done(a: Assertion, check: Check, expected: string): AssertionResult {
  const summary = summarizeAssertion(a);
  return check.ok
    ? { type: a.type, verdict: 'pass', summary, message: `passed: ${summary}` }
    : { type: a.type, verdict: 'fail', summary, message: `expected ${expected}, got ${check.actual}` };
}

async function elementCheck(
  t: Target,
  page: Page,
  timeout: number,
  fn: (loc: Locator) => Promise<Check>,
): Promise<Check> {
  if (!hasTarget(t)) return { ok: false, actual: 'no element target (role/text/testId/css) given' };
  const loc = toLocator(page, t);
  return poll(timeout, () => fn(loc));
}

/**
 * Runs one deterministic assertion against the page. Auto-waits up to `ctx.timeoutMs`
 * (default 5 s) for the condition to hold. Never throws; failures carry expected vs actual
 * in `message`. `ai` assertions are not handled here (S-020) and always report `fail`.
 */
export async function runAssertion(
  page: Page,
  assertion: Assertion,
  ctx: AssertionContext = {},
): Promise<AssertionResult> {
  const timeout = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const a = assertion;
  switch (a.type) {
    case 'urlMatches': {
      const match = patternMatcher(a.pattern);
      const check = await poll(timeout, () => {
        const url = page.url();
        let rel = url;
        try {
          const u = new URL(url);
          rel = u.pathname + u.search;
        } catch {
          // not an absolute URL (about:blank)
        }
        return { ok: match(url) || match(rel), actual: rel };
      });
      return done(a, check, `url ~ ${a.pattern}`);
    }
    case 'titleContains': {
      const check = await poll(timeout, async () => {
        const t = await page.title();
        return { ok: t.includes(a.contains), actual: q(t) };
      });
      return done(a, check, `title ⊇ ${q(a.contains)}`);
    }
    case 'elementVisible': {
      const want = a.visible;
      const check = await elementCheck(a, page, timeout, async (loc) => {
        const v = await loc.first().isVisible();
        return { ok: v === want, actual: v ? 'visible' : 'not visible' };
      });
      return done(a, check, `${describeTarget(a)} ${want ? 'visible' : 'hidden'}`);
    }
    case 'elementText': {
      if (a.equals === undefined && a.contains === undefined) {
        return done(a, { ok: false, actual: 'assertion has neither contains nor equals' }, 'a text check');
      }
      const check = await elementCheck(a, page, timeout, async (loc) => {
        const text = (await loc.first().innerText({ timeout: 500 })).trim();
        const ok = a.equals !== undefined ? text === a.equals : text.includes(a.contains ?? '');
        return { ok, actual: q(text) };
      });
      return done(a, check, summarizeAssertion(a));
    }
    case 'elementValue': {
      const check = await elementCheck(a, page, timeout, async (loc) => {
        const v = await loc.first().inputValue({ timeout: 500 });
        return { ok: v === a.equals, actual: q(v) };
      });
      return done(a, check, summarizeAssertion(a));
    }
    case 'elementCount': {
      const check = await elementCheck(a, page, timeout, async (loc) => {
        const n = await loc.count();
        const ok =
          (a.equals === undefined || n === a.equals) &&
          (a.min === undefined || n >= a.min) &&
          (a.max === undefined || n <= a.max);
        return { ok, actual: String(n) };
      });
      return done(a, check, summarizeAssertion(a));
    }
    case 'responseStatus': {
      const match = patternMatcher(a.urlPattern);
      const method = a.method?.toUpperCase();
      const check = await poll(ctx.capture ? timeout : 0, () => {
        if (!ctx.capture) return { ok: false, actual: 'no step capture available' };
        const hits = ctx.capture.responses.filter((r) => match(r.url) && (!method || r.method === method));
        if (hits.length === 0) return { ok: false, actual: 'no matching response' };
        return {
          ok: hits.some((r) => r.status === a.status),
          actual: [...new Set(hits.map((r) => r.status))].join('/'),
        };
      });
      return done(a, check, `response ~ ${a.urlPattern} → ${a.status}`);
    }
    case 'noConsoleErrors': {
      const allow = a.allow.map(patternMatcher);
      let check: Check;
      if (ctx.capture) {
        const bad = ctx.capture.consoleErrors.filter((m) => !allow.some((f) => f(m)));
        check = { ok: bad.length === 0, actual: `${bad.length} error(s): ${bad.slice(0, 3).map(q).join('; ')}` };
      } else check = { ok: false, actual: 'no step capture available' };
      return done(a, check, 'no console errors');
    }
    case 'downloadExists': {
      const match = a.filenamePattern ? patternMatcher(a.filenamePattern) : () => true;
      const check = await poll(ctx.capture ? timeout : 0, () => {
        if (!ctx.capture) return { ok: false, actual: 'no step capture available' };
        const names = ctx.capture.downloads;
        return { ok: names.some(match), actual: names.length ? `downloads ${names.map(q).join(', ')}` : 'no downloads' };
      });
      return done(a, check, a.filenamePattern ? `download ~ ${a.filenamePattern}` : 'a download');
    }
    case 'apiCheck': {
      const request = ctx.request ?? page.request;
      let check: Check;
      try {
        const base = ctx.baseUrl ?? (page.url().startsWith('http') ? page.url() : undefined);
        const res = await request.fetch(new URL(a.url, base).toString(), { method: a.method, timeout });
        const body = await res.text();
        const statusOk = a.status !== undefined ? res.status() === a.status : res.ok();
        const bodyOk = a.bodyContains === undefined || body.includes(a.bodyContains);
        const parts = [`status ${res.status()}`];
        if (a.bodyContains !== undefined) parts.push(bodyOk ? 'body contains text' : `body ${q(body.slice(0, 80))}`);
        check = { ok: statusOk && bodyOk, actual: parts.join(', ') };
      } catch (err) {
        check = {
          ok: false,
          actual: `request failed: ${err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)}`,
        };
      }
      const exp = `${a.method} ${a.url} → ${a.status ?? '2xx'}${a.bodyContains ? ` with body ⊇ ${q(a.bodyContains)}` : ''}`;
      return done(a, check, exp);
    }
    case 'ai':
      return {
        type: 'ai',
        verdict: 'fail',
        summary: summarizeAssertion(a),
        message: 'AI assertions are judged by the verifier (S-020), not run deterministically',
      };
  }
}
