import type { Verdict } from './run.js';

/** Number of most recent executions (same environment and browser) the flakiness score looks at. */
export const FLAKY_WINDOW = 20;

/** Score from which a case is listed as flaky. */
export const FLAKY_THRESHOLD = 0.2;

/**
 * Flakiness score (0..1) of a case from its final verdicts, oldest first. An execution counts as unstable when
 * it ended `flaky` (passed only after a retry) or when its pass/fail outcome differs from the previous
 * execution (alternating outcomes). Only the last {@link FLAKY_WINDOW} executions count; `skipped` and
 * `needs-review` carry no pass/fail signal and are ignored. The score is unstable executions / executions.
 */
export function flakinessScore(verdicts: readonly Verdict[]): number {
  const window = verdicts.filter((v) => v !== 'skipped' && v !== 'needs-review').slice(-FLAKY_WINDOW);
  if (window.length === 0) return 0;
  let unstable = 0;
  window.forEach((v, i) => {
    const prev = window[i - 1];
    if (v === 'flaky') unstable++;
    else if (prev !== undefined && prev !== 'flaky' && (prev === 'passed') !== (v === 'passed')) unstable++;
  });
  return Math.round((unstable / window.length) * 1000) / 1000;
}
