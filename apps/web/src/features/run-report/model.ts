/** Pure helpers of the run report (S-046). */

export type ReportFilter = 'failed' | 'review' | 'all';

export const BROWSER_LABEL: Record<string, string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };

const FAILED_VERDICTS = ['failed', 'blocked', 'flaky'];

/** Parses the `filter` search param. */
export function parseFilter(raw: unknown): ReportFilter | undefined {
  return raw === 'failed' || raw === 'review' || raw === 'all' ? raw : undefined;
}

/** Which filter bucket a verdict belongs to (`all` for passed / skipped). */
export function bucketOf(verdict: string): ReportFilter {
  if (FAILED_VERDICTS.includes(verdict)) return 'failed';
  if (verdict === 'needs-review') return 'review';
  return 'all';
}

/** Whether a verdict is listed under `filter`. */
export function matchesFilter(verdict: string, filter: ReportFilter): boolean {
  return filter === 'all' || bucketOf(verdict) === filter;
}

/** Default filter: failures when there are any, then review items, otherwise everything. */
export function defaultFilter(verdicts: string[]): ReportFilter {
  if (verdicts.some((v) => bucketOf(v) === 'failed')) return 'failed';
  if (verdicts.some((v) => v === 'needs-review')) return 'review';
  return 'all';
}

/** `staging · WebKit · step 3` (the step only for failed / blocked results). */
export function resultMeta(r: { environment: string; browser: string; failedStep: number | null }): string {
  return [r.environment, BROWSER_LABEL[r.browser] ?? r.browser, r.failedStep !== null ? `step ${r.failedStep}` : '']
    .filter((p) => p !== '')
    .join(' · ');
}

/** Detail heading: `SHOP-TC-44 · WebKit · failed at step 3`. */
export function detailTitle(key: string, browser: string, verdict: string, failedStep: number | null): string {
  const b = BROWSER_LABEL[browser] ?? browser;
  const v = verdict === 'needs-review' ? 'needs review' : verdict;
  return `${key} · ${b} · ${failedStep !== null && (verdict === 'failed' || verdict === 'blocked') ? `${v} at step ${failedStep}` : v}`;
}

/** Last 6 characters of a run id, shown after the hash sign. */
export const shortRunId = (id: string): string => id.slice(-6);

/** Milliseconds as `850 ms` or `1.2 s`. */
export function formatMs(ms: number | null): string {
  if (ms === null) return '–';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export const OVERRIDE_VERDICTS = [
  ['passed', 'Passed'],
  ['failed', 'Failed'],
  ['blocked', 'Blocked'],
  ['flaky', 'Flaky'],
  ['needs-review', 'Needs review'],
  ['skipped', 'Skipped'],
] as const;
