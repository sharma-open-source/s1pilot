import { finalAttempts, repos, type Db, type JobQueue } from '@s1pilot/db';
import {
  BrowserNameSchema,
  ExecutionModeSchema,
  IdSchema,
  PlanChecksSchema,
  newId,
  summarizeChecks,
  type BrowserName,
  type CaseResult,
  type CaseRunResult,
  type ExecutionMode,
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
  /** Plan-run settings (S-049). */
  planId: IdSchema.optional(),
  /** Playwright device descriptor name (S-051). */
  device: z.string().optional(),
  /** Failed instances are retried up to this many times; a pass after a retry is `flaky` (S-051). */
  retries: z.number().int().min(0).optional(),
  /** Most jobs of this run executing at once, further capped by the number of server workers (S-051). */
  parallelism: z.number().int().min(1).optional(),
  /** Accessibility / console / network checks (S-053); visual comparison is a later spec. */
  checks: PlanChecksSchema.optional(),
});
export type RunCaseJobPayload = z.infer<typeof RunCaseJobPayloadSchema>;

const TERMINAL: ReadonlySet<RunStatus> = new Set(['finished', 'aborted', 'passed', 'failed', 'needs-review', 'cancelled', 'error']);

/** True for run statuses that never change again. */
export const isTerminalRunStatus = (status: RunStatus): boolean => TERMINAL.has(status);

const stepStatus = (s: StepReport): StepResult['status'] =>
  s.verdict === 'passed' || s.verdict === 'failed' || s.verdict === 'blocked' || s.verdict === 'skipped' ? s.verdict : 'blocked';

/** `checks` summary and, when a failing check made the case fail, its reason (S-053). */
function checkColumns(result: CaseRunResult): { checks?: ReturnType<typeof summarizeChecks>; reason?: string } {
  if (!result.checks || result.checks.length === 0) return {};
  const failed = result.checks.filter((c) => c.severity === 'fail');
  const onlyChecks = result.verdict === 'failed' && !result.steps.some((s) => s.verdict === 'failed' || s.verdict === 'blocked');
  return {
    checks: summarizeChecks(result.checks),
    ...(failed.length > 0 && onlyChecks ? { reason: `checks failed: ${failed.map((c) => `${c.kind} (${c.items.filter((i) => i.severity === 'fail').length})`).join(', ')}` } : {}),
  };
}

/** A finished manual execution to persist (see {@link RunLifecycle.recordManualCase}). */
export interface ManualCaseRecord {
  runId: string;
  testCase: TestCase;
  environmentId?: string;
  browser?: BrowserName;
  caseResultId: string;
  verdict: CaseResult['verdict'];
  durationMs: number;
  /** Why the case was not executed (`skipped by tester`). */
  reason?: string;
  steps: { index: number; status: StepResult['status']; actionTaken?: string; evidence: StepResult['evidence'] }[];
}

/** Run state machine: `queued → running → passed | failed | needs-review | cancelled | error`. */
export interface RunLifecycle {
  /** Serialises state changes of one run (awaits inside repos could otherwise interleave). */
  lock<T>(runId: string, fn: () => Promise<T>): Promise<T>;
  /** `queued → running` (sets `startedAt`, emits `run.started`) when the first job starts. */
  markRunning(runId: string, totalCases: number): Promise<void>;
  /**
   * Drops results of a case from an earlier attempt of the same run, then refreshes the summary. With `target`
   * only the results of that environment and browser go (matrix runs hold several per case).
   */
  discardCase(runId: string, caseId: string, target?: { environmentId: string; browser: string }): Promise<void>;
  /** Records a case that was not executed (`skipped`, e.g. quarantined) with the reason, then refreshes the summary. */
  recordSkipped(input: { runId: string; testCase: TestCase; environmentId: string; browser: BrowserName; mode: ExecutionMode; reason: string }): Promise<RunSummary>;
  /** Persists a finished case instance (case, steps, decisions) and updates the summary counts. */
  recordCase(input: { runId: string; testCase: TestCase; environmentId: string; attempt: number; result: CaseRunResult }): Promise<RunSummary>;
  /**
   * Persists a finished manual execution as a `manual`-mode case result with its steps and evidence (S-055). A
   * hybrid AI pre-run result of the same case instance is replaced. Then refreshes the summary.
   */
  recordManualCase(input: ManualCaseRecord): Promise<RunSummary>;
  /** Sets the final status once every job of the run is terminal. Returns the status when it was set. */
  finalize(runId: string): Promise<RunStatus | undefined>;
  /** Cancels queued jobs and marks the run `cancelled`; returns the cancelled jobs' ids of running jobs. */
  cancel(runId: string): Promise<{ runningJobIds: string[] }>;
}

/** Creates the run lifecycle over the database, the job queue and the event bus. */
export function createRunLifecycle(deps: { db: Db; queue: JobQueue; bus: RunEventBus; onReviewCreated?: (projectId: string) => void }): RunLifecycle {
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
    // Retried instances count once, by their final attempt.
    const cases = finalAttempts(await repos.results.listCases(db, runId));
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

    recordSkipped: ({ runId, testCase, environmentId, browser, mode, reason }) =>
      lock(runId, async () => {
        await repos.results.createCase(db, {
          id: newId(),
          runId,
          caseId: testCase.id,
          caseVersion: testCase.version,
          environmentId,
          browser,
          attempt: 1,
          verdict: 'skipped',
          durationMs: 0,
          mode: mode === 'explore' ? 'explore' : 'replay',
          escalations: 0,
          reason,
        });
        return refreshSummary(runId);
      }),

    discardCase: (runId, caseId, target) =>
      lock(runId, async () => {
        const scope = target ? ' AND environment_id = ? AND browser = ?' : '';
        const scopeArgs = target ? [target.environmentId, target.browser] : [];
        // A retried attempt replaces the discarded result, so its pending review item goes with it.
        db.sqlite
          .prepare(
            `DELETE FROM review_items WHERE kind = 'verdict' AND status = 'pending' AND ref_id IN (SELECT id FROM case_results WHERE run_id = ? AND case_id = ?${scope})`,
          )
          .run(runId, caseId, ...scopeArgs);
        db.sqlite.prepare(`DELETE FROM case_results WHERE run_id = ? AND case_id = ?${scope}`).run(runId, caseId, ...scopeArgs);
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
          ...checkColumns(result),
        });
        if (result.verdict === 'needs-review') {
          // Uncertain verdicts wait in the review queue (S-047); the workspace count follows `case.finished`.
          const run = await repos.runs.get(db, runId);
          if (run) {
            await repos.reviews.create(db, { id: newId(), projectId: run.projectId, kind: 'verdict', refId: result.caseResultId, status: 'pending' });
            deps.onReviewCreated?.(run.projectId);
          }
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

    recordManualCase: (input) =>
      lock(input.runId, async () => {
        const { runId, testCase, environmentId, browser } = input;
        // A hybrid pre-run of this case instance is superseded by the tester's verdicts.
        const old = (await repos.results.listCases(db, runId)).filter(
          (r) => r.caseId === testCase.id && r.environmentId === environmentId && r.browser === browser,
        );
        for (const r of old) {
          db.sqlite.prepare(`DELETE FROM review_items WHERE kind = 'verdict' AND status = 'pending' AND ref_id = ?`).run(r.id);
          db.sqlite.prepare('DELETE FROM case_results WHERE id = ?').run(r.id);
        }
        await repos.results.createCase(db, {
          id: input.caseResultId,
          runId,
          caseId: testCase.id,
          caseVersion: testCase.version,
          ...(environmentId ? { environmentId } : {}),
          ...(browser ? { browser } : {}),
          attempt: 1,
          verdict: input.verdict,
          durationMs: input.durationMs,
          mode: 'manual',
          escalations: 0,
          ...(input.reason ? { reason: input.reason } : {}),
        });
        for (const s of input.steps) {
          await repos.results.addStep(db, {
            id: newId(),
            caseResultId: input.caseResultId,
            stepIndex: s.index,
            status: s.status,
            ...(s.actionTaken ? { actionTaken: s.actionTaken } : {}),
            evidence: s.evidence,
          });
        }
        return refreshSummary(runId);
      }),

    finalize: (runId) =>
      lock(runId, async () => {
        const run = await repos.runs.get(db, runId);
        if (!run || isTerminalRunStatus(run.status)) return undefined;
        const jobs = await queue.listByRun(runId);
        const manualItems = await repos.manual.listByRun(db, runId);
        if (jobs.length === 0 && manualItems.length === 0) return undefined;
        if (jobs.some((j) => j.status === 'queued' || j.status === 'running')) return undefined;
        // Manual items still waiting for a tester keep the run open (S-055).
        if (manualItems.some((m) => m.status === 'todo' || m.status === 'in-progress')) return undefined;
        const s = run.summary;
        const status: RunStatus = jobs.some((j) => j.status === 'failed')
          ? 'error'
          : s.failed + s.blocked + s.flaky > 0
            ? 'failed'
            : s.needsReview > 0
              ? 'needs-review'
              : 'passed';
        await repos.runs.update(db, runId, { status, finishedAt: ts() });
        await repos.analytics.refreshForRun(db, run.projectId, run.startedAt);
        bus.emit({ type: 'run.finished', runId, ts: ts(), status, summary: s });
        return status;
      }),

    cancel: (runId) =>
      lock(runId, async () => {
        const affected = await queue.cancelByRun(runId);
        const run = await repos.runs.get(db, runId);
        if (run && !isTerminalRunStatus(run.status)) {
          await repos.runs.update(db, runId, { status: 'cancelled', finishedAt: ts() });
          await repos.analytics.refreshForRun(db, run.projectId, run.startedAt);
          bus.emit({ type: 'run.finished', runId, ts: ts(), status: 'cancelled', summary: run.summary });
        }
        return { runningJobIds: affected.filter((j) => j.status === 'running').map((j) => j.id) };
      }),
  };
}
