import type { Priority, Thresholds, Verdict } from '@s1pilot/domain';

import type { AssertionResult } from './deterministic.js';

/** Input of {@link verdictFor}. */
export interface VerdictInput {
  /** P(expected is true) from the AI judge; omit when only deterministic evidence exists. */
  pTrue?: number;
  thresholds: Pick<Thresholds, 'pass' | 'fail'>;
  /** Deterministic assertion outcomes for the same step. */
  deterministic: AssertionResult[];
  priority: Priority;
  /** When false (default policy) a P0 case cannot pass on AI evidence alone. */
  allowAiOnlyPassForP0: boolean;
  /** Dual-order agreement of the AI judgement; `false` forces `needs-review` unless a check failed. */
  dualOrderAgreed?: boolean;
}

/** Verdicts a verification can produce. */
export type VerifyVerdict = Extract<Verdict, 'passed' | 'failed' | 'needs-review'>;

/**
 * Combines AI and deterministic evidence into one verdict:
 * any failed deterministic check fails; otherwise `pTrue >= pass` passes, `<= fail` fails and
 * anything between needs review. A P0 case whose only evidence is the AI judge needs review instead
 * of passing unless `allowAiOnlyPassForP0`. With no AI judgement the deterministic checks decide
 * (no evidence at all counts as passed: the step's action succeeded and nothing was asserted).
 */
export function verdictFor(input: VerdictInput): VerifyVerdict {
  if (input.deterministic.some((d) => d.verdict === 'fail')) return 'failed';
  if (input.pTrue === undefined) return 'passed';
  if (input.dualOrderAgreed === false) return 'needs-review';
  const { pass, fail } = input.thresholds;
  if (input.pTrue >= pass) {
    const aiOnly = input.deterministic.length === 0;
    return input.priority === 'P0' && aiOnly && !input.allowAiOnlyPassForP0 ? 'needs-review' : 'passed';
  }
  if (input.pTrue <= fail) return 'failed';
  return 'needs-review';
}

const SEVERITY: Record<Verdict, number> = {
  skipped: 0,
  passed: 1,
  'needs-review': 2,
  flaky: 3,
  blocked: 4,
  failed: 5,
};

/** Worst of the given verdicts (`failed` > `blocked` > `flaky` > `needs-review` > `passed` > `skipped`); `passed` when empty. */
export function worstVerdict(verdicts: Verdict[]): Verdict {
  let worst: Verdict | undefined;
  for (const v of verdicts) if (worst === undefined || SEVERITY[v] > SEVERITY[worst]) worst = v;
  return worst ?? 'passed';
}

/** Case verdict = worst step verdict. */
export function caseVerdict(stepVerdicts: Verdict[]): Verdict {
  return worstVerdict(stepVerdicts);
}
