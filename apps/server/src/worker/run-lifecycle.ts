import { repos, type Db, type JobQueue } from '@s1pilot/db';
import {
  BrowserNameSchema,
  ExecutionModeSchema,
  IdSchema,
  PlanChecksSchema,
  newId,
  type CaseRunResult,
  type RunStatus,
  type RunSummary,
  type StepReport,
  type StepResult,
  type TestCase,
} from '@s1pilot/domain';
import { z } from 'zod';

import type { RunEventBus } from './event-bus.js';

/** Job type of one case (all its parameter rows) in one environment and browser. */
export const RUN_CASE_JOB = 'run-case';

/** Payload of a `run-case` job. */
export const RunCaseJobPayloadSchema = z.object({
  runId: IdSchema,
  projectId: IdSchema,
  caseId: IdSchema,
  environmentId: IdSchema,
  browser: BrowserNameSchema,
  mode: ExecutionModeSchema,
  attended: z.boolean().default(false),
  /** Plan-run settings (S-049). Carried on the job for later specs; the worker does not act on them yet. */
  planId: IdSchema.optional(),
  device: z.string().optional(),
  /** TODO(S-051): retry flaky/failed cases. */
  retries: z.number().int().min(0).optional(),
  /** TODO(S-051): per-run parallelism cap. */
  parallelism: z.number().int().min(1).optional(),
  /** TODO(S-053): a11y / console / visual checks. */
  checks: PlanChecksSchema.optional(),
});
export type RunCaseJobPayload = z.infer<typeof RunCaseJobPayloadSchema>;

const TERMINAL: ReadonlySet<RunStatus> = new Set(['finished', 'aborted', 'passed', 'failed', 'needs-review', 'cancelled', 'error']);

/** True for run statuses that never change again. */
export const isTerminalRunStatus = (status: RunStatus): boolean => TERMINAL.has(status);

const stepStatus = (s: StepReport): StepResult['status'] =>
  s.verdict === 'passed' || s.verdict === 'failed' || s.verdict === 'blocked' || s.verdict === 'skipped' ? s.verdict : 'blocked';

/** Run state machine: `queued → running → passed | failed | needs-review | cancelled | error`. */
export interface RunLifecycle {
  /** Serialises state changes of one run (awaits inside repos could otherwise interleave). */
  lock<T>(runId: string, fn: () => Promise<T>): Promise<T>;
  /** `queued → running` (sets `startedAt`, emits `run.started`) when the first job starts. */
  markRunning(runId: string, totalCases: number): Promise<void>;
  /** Drops results of a case from an earlier attempt of the same run, then refreshes the summary. */
  discardCase(runId: string, caseId: string): Promise<void>;
  /** Persists a finished case instance (case, steps, decisions) and updates the summary counts. */
  recordCase(input: { runId: string; testCase: TestCase; environmentId: string; attempt: number; result: CaseRunResult }): Promise<RunSummary>;
  /** Sets the final status once every job of the run is terminal. Returns the status when it was set. */
  finalize(runId: string): Promise<RunStatus | undefined>;
  /** Cancels queued jobs and marks the run `cancelled`; returns the cancelled jobs' ids of running jobs. */
  cancel(runId: string): Promise<{ runningJobIds: string[] }>;
}

/** Creates the run lifecycle over the database, the job queue and the event bus. */
export function createRunLifecycle(deps: { db: Db; queue: JobQueue; bus: RunEventBus }): RunLifecycle {
  const { db, queue, bus } = deps;
  const tails = new Map<string, Promise<unknown>>();
  const ts = (): string => new Date().toISOString();

  const lock = <T>(runId: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(runId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(runId, tail);
    void tail.then(() => {
      if (tails.get(runId) === tail) tails.delete(runId);
    });
    return run;
  };

  const refreshSummary = async (runId: string): Promise<RunSummary> => {
    const cases = await repos.results.listCases(db, runId);
    const count = (v: string): number => cases.filter((c) => c.verdict === v).length;
    const summary: RunSummary = {
      passed: count('passed'),
      failed: count('failed'),
      blocked: count('blocked'),
      skipped: count('skipped'),
      flaky: count('flaky'),
      needsReview: count('needs-review'),
    };
    await repos.runs.update(db, runId, { summary });
    return summary;
  };

  return {
    lock,

    markRunning: (runId, totalCases) =>
      lock(runId, async () => {
        const run = await repos.runs.get(db, runId);
        if (!run || run.status !== 'queued') return;
        await repos.runs.update(db, runId, { status: 'running', startedAt: ts() });
        bus.emit({ type: 'run.started', runId, ts: ts(), totalCases });
      }),

    discardCase: (runId, caseId) =>
      lock(runId, async () => {
        // A retried attempt replaces the discarded result, so its pending review item goes with it.
        db.sqlite
          .prepare(
            "DELETE FROM review_items WHERE kind = 'verdict' AND status = 'pending' AND ref_id IN (SELECT id FROM case_results WHERE run_id = ? AND case_id = ?)",
          )
          .run(runId, caseId);
        db.sqlite.prepare('DELETE FROM case_results WHERE run_id = ? AND case_id = ?').run(runId, caseId);
        await refreshSummary(runId);
      }),

    recordCase: ({ runId, testCase, environmentId, attempt, result }) =>
      lock(runId, async () => {
        await repos.results.createCase(db, {
          id: result.caseResultId,
          runId,
          caseId: testCase.id,
          caseVersion: testCase.version,
          environmentId,
          browser: result.browser,
          attempt,
          verdict: result.verdict,
          durationMs: result.durationMs,
          mode: result.mode,
          escalations: result.steps.flatMap((s) => s.decisions).filter((d) => d.escalatedTo !== undefined).length,
        });
        if (result.verdict === 'needs-review') {
          // Uncertain verdicts wait in the review queue (S-047); the workspace count follows `case.finished`.
          const run = await repos.runs.get(db, runId);
          if (run) await repos.reviews.create(db, { id: newId(), projectId: run.projectId, kind: 'verdict', refId: result.caseResultId, status: 'pending' });
        }
        for (const s of result.steps) {
          await repos.results.addStep(db, {
            id: newId(),
            caseResultId: result.caseResultId,
            stepIndex: s.index,
            status: stepStatus(s),
            ...(s.mode ? { mode: s.mode } : {}),
            ...(s.actionTaken ? { actionTaken: s.actionTaken } : {}),
            decisions: s.decisions,
            assertions: s.assertions,
            latencyMs: s.durationMs,
          });
        }
        return refreshSummary(runId);
      }),

    finalize: (runId) =>
      lock(runId, async () => {
        const run = await repos.runs.get(db, runId);
        if (!run || isTerminalRunStatus(run.status)) return undefined;
        const jobs = await queue.listByRun(runId);
        if (jobs.length === 0 || jobs.some((j) => j.status === 'queued' || j.status === 'running')) return undefined;
        const s = run.summary;
        const status: RunStatus = jobs.some((j) => j.status === 'failed')
          ? 'error'
          : s.failed + s.blocked + s.flaky > 0
            ? 'failed'
            : s.needsReview > 0
              ? 'needs-review'
              : 'passed';
        await repos.runs.update(db, runId, { status, finishedAt: ts() });
        bus.emit({ type: 'run.finished', runId, ts: ts(), status, summary: s });
        return status;
      }),

    cancel: (runId) =>
      lock(runId, async () => {
        const affected = await queue.cancelByRun(runId);
        const run = await repos.runs.get(db, runId);
        if (run && !isTerminalRunStatus(run.status)) {
          await repos.runs.update(db, runId, { status: 'cancelled', finishedAt: ts() });
          bus.emit({ type: 'run.finished', runId, ts: ts(), status: 'cancelled', summary: run.summary });
        }
        return { runningJobIds: affected.filter((j) => j.status === 'running').map((j) => j.id) };
      }),
  };
}
