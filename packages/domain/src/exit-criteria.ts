import { z } from 'zod';

import { DefectSeveritySchema, type DefectSeverity } from './defect.js';
import { ExitCriterionSchema, type ExitCriterion } from './plan.js';
import { PrioritySchema, type Priority } from './test-case.js';

/** Process exit code used by the CLI / CI when a plan's exit criteria are not met (S-063). */
export const EXIT_CRITERIA_UNMET_EXIT_CODE = 4;

/** Typed exit criterion (spec S-056). Plans store the loose `{kind, params}` form; see {@link parseExitCriterion}. */
export const TypedExitCriterionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('passRate'), priority: z.array(PrioritySchema).min(1), minPct: z.number().min(0).max(100) }),
  z.object({ type: z.literal('noOpenDefects'), minSeverity: DefectSeveritySchema }),
  z.object({ type: z.literal('reviewQueueEmpty') }),
  z.object({ type: z.literal('noFlaky'), priority: z.array(PrioritySchema).min(1) }),
  z.object({ type: z.literal('allExecuted') }),
]);
export type TypedExitCriterion = z.infer<typeof TypedExitCriterionSchema>;

const ALL_PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];

function priorities(v: unknown, fallback: Priority[]): Priority[] {
  const list = (Array.isArray(v) ? v : []).filter((p): p is Priority => PrioritySchema.safeParse(p).success);
  return list.length > 0 ? list : fallback;
}

function pct(v: unknown, fallback: number): number {
  return typeof v === 'number' && v >= 0 && v <= 100 ? v : fallback;
}

/**
 * Maps a stored plan criterion (`p0-passed`, `pass-rate`, `no-open-defects`, `review-queue-empty`, `no-flaky`,
 * `all-executed`) to its typed form. Unknown kinds return undefined.
 */
export function parseExitCriterion(c: ExitCriterion): TypedExitCriterion | undefined {
  const p = c.params;
  switch (c.kind) {
    case 'p0-passed':
      return { type: 'passRate', priority: ['P0'], minPct: pct(p['percent'], 100) };
    case 'pass-rate':
      return { type: 'passRate', priority: priorities(p['priorities'] ?? p['priority'], ['P1', 'P2']), minPct: pct(p['percent'] ?? p['minPct'], 95) };
    case 'no-open-defects': {
      const sev = DefectSeveritySchema.safeParse(p['severity'] ?? p['minSeverity']);
      return { type: 'noOpenDefects', minSeverity: sev.success ? sev.data : 'S2' };
    }
    case 'review-queue-empty':
      return { type: 'reviewQueueEmpty' };
    case 'no-flaky':
      return { type: 'noFlaky', priority: priorities(p['priorities'] ?? p['priority'], ALL_PRIORITIES) };
    case 'all-executed':
      return { type: 'allExecuted' };
    default:
      return undefined;
  }
}

/** Facts about a run the pure evaluator needs (gathered from the database by the server). */
export interface ExitCriteriaFacts {
  /** Final-attempt case results of the run with the case priority. */
  results: Array<{ priority: Priority; verdict: string }>;
  /** Open defects (draft / open / in-progress) of the project. */
  openDefects: Array<{ severity: DefectSeverity }>;
  /** Pending review items of the project. */
  pendingReviews: number;
}

export interface ExitCriterionResult {
  criterion: ExitCriterion;
  /** Human-readable criterion text. */
  label: string;
  met: boolean;
  actual: string;
  detail: string;
}

export interface ExitCriteriaEvaluation {
  met: boolean;
  items: ExitCriterionResult[];
}

const SEVERITY_ORDER: DefectSeverity[] = ['S1', 'S2', 'S3', 'S4'];

/** Evaluates one typed criterion against the facts. */
export function evaluateTypedCriterion(c: TypedExitCriterion, facts: ExitCriteriaFacts): Pick<ExitCriterionResult, 'label' | 'met' | 'actual' | 'detail'> {
  switch (c.type) {
    case 'passRate': {
      const label = `≥ ${c.minPct}% of ${c.priority.join('/')} passed`;
      const scoped = facts.results.filter((r) => c.priority.includes(r.priority) && r.verdict !== 'skipped');
      if (scoped.length === 0) return { label, met: true, actual: 'no cases', detail: `No ${c.priority.join('/')} cases were executed.` };
      const passed = scoped.filter((r) => r.verdict === 'passed').length;
      const rate = (passed / scoped.length) * 100;
      const shown = Math.round(rate * 10) / 10;
      return { label, met: rate >= c.minPct, actual: `${shown}%`, detail: `${passed} of ${scoped.length} passed.` };
    }
    case 'noOpenDefects': {
      const label = `No open defects ≥ ${c.minSeverity}`;
      const limit = SEVERITY_ORDER.indexOf(c.minSeverity);
      const open = facts.openDefects.filter((d) => SEVERITY_ORDER.indexOf(d.severity) <= limit);
      return {
        label,
        met: open.length === 0,
        actual: `${open.length} open`,
        detail: open.length === 0 ? 'No matching open defects.' : `${open.length} open defect(s) of severity ${c.minSeverity} or worse.`,
      };
    }
    case 'reviewQueueEmpty': {
      const n = facts.pendingReviews;
      return { label: 'Review queue empty', met: n === 0, actual: `${n} pending`, detail: n === 0 ? 'Nothing waits for review.' : `${n} item(s) wait for review.` };
    }
    case 'noFlaky': {
      const label = `No flaky ${c.priority.join('/')} cases`;
      const flaky = facts.results.filter((r) => c.priority.includes(r.priority) && r.verdict === 'flaky').length;
      return { label, met: flaky === 0, actual: `${flaky} flaky`, detail: flaky === 0 ? 'No flaky results.' : `${flaky} flaky result(s).` };
    }
    case 'allExecuted': {
      const notRun = facts.results.filter((r) => r.verdict === 'skipped' || r.verdict === 'blocked').length;
      return {
        label: 'All cases executed',
        met: notRun === 0,
        actual: `${facts.results.length - notRun} of ${facts.results.length} executed`,
        detail: notRun === 0 ? 'Every case ran.' : `${notRun} case(s) skipped or blocked.`,
      };
    }
  }
}

/**
 * Evaluates plan exit criteria against run facts. Criteria of an unknown kind are reported as not met (they cannot
 * be verified). No criteria means met.
 */
export function evaluateCriteria(criteria: readonly ExitCriterion[], facts: ExitCriteriaFacts): ExitCriteriaEvaluation {
  const items = criteria.map((raw): ExitCriterionResult => {
    const criterion = ExitCriterionSchema.parse(raw);
    const typed = parseExitCriterion(criterion);
    if (!typed) return { criterion, label: criterion.kind, met: false, actual: 'unknown', detail: `Unknown criterion "${criterion.kind}".` };
    return { criterion, ...evaluateTypedCriterion(typed, facts) };
  });
  return { met: items.every((i) => i.met), items };
}
