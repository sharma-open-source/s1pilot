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

/** Fields of a result row that identify one case execution (all of its retry attempts share them). */
interface AttemptKey {
  caseId: string;
  environment: string;
  browser: string;
  attempt: number;
}

const executionKey = (r: AttemptKey): string => `${r.caseId}|${r.environment}|${r.browser}`;

/** Number of attempts per case execution (`caseId|environment|browser`), for "attempt 2 of 3" labels. */
export function attemptTotals(results: readonly AttemptKey[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of results) out.set(executionKey(r), Math.max(out.get(executionKey(r)) ?? 0, r.attempt));
  return out;
}

/**
 * `staging · WebKit · attempt 2 of 3 · step 3 · 12.4 s`: the attempt only when the case was retried, the step only
 * for failed / blocked results.
 */
export function resultMeta(
  r: AttemptKey & { failedStep: number | null; durationMs?: number | null },
  totals?: ReadonlyMap<string, number>,
): string {
  const total = totals?.get(executionKey(r)) ?? 1;
  return [
    r.environment,
    BROWSER_LABEL[r.browser] ?? r.browser,
    total > 1 ? `attempt ${r.attempt} of ${total}` : '',
    r.failedStep !== null ? `step ${r.failedStep}` : '',
    r.durationMs !== undefined && r.durationMs !== null && r.durationMs > 0 ? formatMs(r.durationMs) : '',
  ]
    .filter((p) => p !== '')
    .join(' · ');
}

/** Wall-clock run time as `45 s`, `3m 05s` or `1h 02m`; `null` until the run has started and finished. */
export function runDuration(startedAt: string | undefined, finishedAt: string | undefined): string | null {
  if (startedAt === undefined || finishedAt === undefined) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
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
