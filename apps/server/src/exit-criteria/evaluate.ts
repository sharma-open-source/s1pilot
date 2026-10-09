import { finalAttempts, repos, type Db } from '@s1pilot/db';
import { evaluateCriteria, type ExitCriteriaEvaluation, type Priority, type TestPlan, type TestRun } from '@s1pilot/domain';
import { z } from 'zod';

const OPEN_DEFECT_STATUSES = new Set(['draft', 'open', 'in-progress']);

/**
 * Evaluates the exit criteria of `plan` against `run` from the current database state. Cheap enough to call on
 * every report load, so it is always fresh after a review is decided or a defect is closed.
 * A run without a plan (or a plan without criteria) is vacuously met with no items.
 */
export async function evaluateExitCriteria(run: TestRun, plan: TestPlan | undefined, db: Db): Promise<ExitCriteriaEvaluation> {
  if (!plan || plan.exitCriteria.length === 0) return { met: true, items: [] };
  const results = finalAttempts(await repos.results.listCases(db, run.id));
  const priorities = new Map<string, Priority>();
  const rows: Array<{ priority: Priority; verdict: string }> = [];
  for (const r of results) {
    if (!priorities.has(r.caseId)) priorities.set(r.caseId, (await repos.cases.get(db, r.caseId))?.priority ?? 'P2');
    rows.push({ priority: priorities.get(r.caseId) ?? 'P2', verdict: r.verdict });
  }
  const defects = (await repos.defects.listByProject(db, run.projectId)).filter((d) => OPEN_DEFECT_STATUSES.has(d.status));
  const pending = await repos.reviews.list(db, { projectId: run.projectId, status: 'pending' });
  return evaluateCriteria(plan.exitCriteria, { results: rows, openDefects: defects, pendingReviews: pending.length });
}

/** Sign-off recorded on a run. */
export const SignOffSchema = z.object({ by: z.string(), at: z.string(), note: z.string(), criteriaMet: z.boolean() });
export type SignOff = z.infer<typeof SignOffSchema>;

const key = (runId: string): string => `run-signoff:${runId}`;

/** The run's sign-off, if any (stored in the `settings` table; no migration). */
export async function getSignOff(db: Db, runId: string): Promise<SignOff | null> {
  const parsed = SignOffSchema.safeParse(await repos.settings.get(db, key(runId)));
  return parsed.success ? parsed.data : null;
}

/** Records (replaces) the sign-off of a run. */
export async function setSignOff(db: Db, runId: string, signOff: SignOff): Promise<void> {
  await repos.settings.set(db, key(runId), signOff);
}
