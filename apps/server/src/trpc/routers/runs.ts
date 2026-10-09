import {
  BrowserNameSchema,
  ExecutionModeSchema,
  IdSchema,
  ProjectKeySchema,
  RunControlMessageSchema,
  RunStatusSchema,
  S1PilotError,
  newId,
  type BrowserName,
  type ExecutionMode,
  type Project,
  type RunTrigger,
  type TestCase,
  type TestPlan,
  type TestRun,
} from '@s1pilot/domain';
import { z } from 'zod';

import { isTerminalRunStatus, RUN_CASE_JOB, RunCaseJobPayloadSchema, type RunCaseJobPayload } from '../../worker/run-lifecycle.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { RecentInput, recentRuns } from './dashboard.js';
import { requireCase, requireProject } from './helpers.js';
import { expandPlan, requirePlan } from './plans.js';
import { reportProcedure } from './run-report.js';

async function requireRun(ctx: Context, runId: string): Promise<TestRun> {
  const run = await ctx.repos.runs.get(ctx.db, runId);
  if (!run) throw new S1PilotError('RUN_NOT_FOUND', `Run not found: ${runId}`, { runId });
  return run;
}

/** Creates the run row and one `run-case` job per entry (case x environment x browser); wakes the workers. */
async function startRun(
  ctx: Context,
  project: Project,
  jobs: { caseId: string; config: Omit<RunCaseJobPayload, 'runId' | 'projectId' | 'caseId'> }[],
  buildRef: string | undefined,
  planId?: string,
  trigger: RunTrigger = 'manual',
  skipped: { testCase: TestCase; environmentId: string; browser: BrowserName; mode: ExecutionMode; reason: string }[] = [],
): Promise<TestRun> {
  const run = await ctx.repos.runs.create(ctx.db, {
    id: newId(),
    projectId: project.id,
    ...(planId ? { planId } : {}),
    trigger,
    status: 'queued',
    ...(buildRef ? { buildRef } : {}),
  });
  for (const s of skipped) await ctx.runtime.lifecycle.recordSkipped({ runId: run.id, ...s });
  for (const { caseId, config } of jobs) {
    await ctx.runtime.queue.enqueue({
      type: RUN_CASE_JOB,
      runId: run.id,
      payload: { ...config, runId: run.id, projectId: project.id, caseId } satisfies RunCaseJobPayload,
    });
  }
  ctx.runtime.workers.wake();
  return run;
}

/** How a plan run is started (manual, schedule, webhook). */
export interface PlanRunOptions {
  trigger: RunTrigger;
  includeQuarantined?: boolean;
  attended?: boolean;
  buildRef?: string;
  /** Restrict the matrix to one environment (name or id), e.g. from a webhook payload. */
  environment?: string;
}

/** Expands a plan into jobs and queues a run with the given trigger. Throws `INVALID_STATE` when nothing is runnable. */
export async function startPlanRun(ctx: Context, project: Project, plan: TestPlan, opts: PlanRunOptions): Promise<TestRun> {
  const input = { includeQuarantined: opts.includeQuarantined ?? false, attended: opts.attended ?? false, buildRef: opts.buildRef };
  const x = await expandPlan(ctx, project, plan, { includeQuarantined: input.includeQuarantined });
  if (opts.environment !== undefined) {
    const envs = await ctx.repos.environments.listByProject(ctx.db, project.id);
    const env = envs.find((e) => e.name === opts.environment || e.id === opts.environment);
    if (!env) throw new S1PilotError('ENVIRONMENT_NOT_FOUND', `Environment not found: ${opts.environment}`, { environment: opts.environment });
    x.combos = x.combos.filter((c) => c.environmentId === env.id);
    x.jobs = x.runnable.length * x.combos.length;
  }
  if (x.jobs === 0) {
    throw new S1PilotError('INVALID_STATE', 'The plan matches no runnable cases or has no allowed matrix entries', {
      planId: plan.id,
      matched: x.matched.length,
      skippedCombos: x.skippedCombos.length,
    });
  }
  const jobs = x.runnable.flatMap((c) =>
    x.combos.map((combo) => ({
      caseId: c.id,
      config: {
        environmentId: combo.environmentId,
        browser: combo.browser,
        ...(combo.device !== undefined ? { device: combo.device } : {}),
        mode: plan.mode,
        // 'block' = nobody is watching, escalations block the step; 'pause' waits for a human.
        attended: input.attended || plan.unattended === 'pause',
        planId: plan.id,
        retries: plan.retries,
        parallelism: plan.parallelism,
        checks: plan.checks,
      },
    })),
  );
  // Quarantined cases do not run; they show up as `skipped (quarantined)` once per environment/browser.
  const skipped = x.skippedQuarantined.flatMap((testCase) =>
    x.combos.map((combo) => ({
      testCase,
      environmentId: combo.environmentId,
      browser: combo.browser,
      mode: plan.mode,
      reason: 'quarantined',
    })),
  );
  return startRun(ctx, project, jobs, input.buildRef, plan.id, opts.trigger, skipped);
}

/** Run configuration and job states, derived from the run's jobs. */
async function describeRun(ctx: Context, runId: string) {
  const jobs = await ctx.runtime.queue.listByRun(runId);
  const parsed = jobs.map((j) => ({ job: j, payload: RunCaseJobPayloadSchema.safeParse(j.payload) }));
  const first = parsed.find((p) => p.payload.success)?.payload;
  const config = first?.success ? first.data : undefined;
  const environment = config ? await ctx.repos.environments.get(ctx.db, config.environmentId) : undefined;
  const caseTitles = new Map<string, { key: string; title: string }>();
  const lookup = async (caseId: string) => {
    if (!caseTitles.has(caseId)) {
      const c = await ctx.repos.cases.get(ctx.db, caseId);
      caseTitles.set(caseId, { key: c?.key ?? caseId, title: c?.title ?? '' });
    }
    return caseTitles.get(caseId) as { key: string; title: string };
  };
  const jobViews = await Promise.all(
    parsed.map(async ({ job, payload }) => ({
      id: job.id,
      status: job.status,
      attempts: job.attempts,
      ...(job.error ? { error: job.error } : {}),
      ...(payload.success ? { caseId: payload.data.caseId, caseKey: (await lookup(payload.data.caseId)).key } : {}),
    })),
  );
  const count = (s: string): number => jobs.filter((j) => j.status === s).length;
  return {
    config: config
      ? {
          environmentId: config.environmentId,
          ...(environment ? { environment: environment.name } : {}),
          browser: config.browser,
          mode: config.mode,
          attended: config.attended,
        }
      : null,
    jobs: jobViews,
    progress: {
      total: jobs.length,
      queued: count('queued'),
      running: count('running'),
      completed: count('completed'),
      failed: count('failed'),
      cancelled: count('cancelled'),
    },
    lookup,
  };
}

const CreateInput = z.object({
  projectKey: ProjectKeySchema,
  /** Human keys of the cases to run (`SHOP-TC-42`). Required unless `planId` is given. */
  caseKeys: z.array(z.string().min(1)).min(1).optional(),
  /** Environment name (or id). Required unless `planId` is given. */
  environment: z.string().min(1).optional(),
  /** Run a test plan: expands cases x matrix combos and applies the plan's mode, retries, parallelism and checks. */
  planId: IdSchema.optional(),
  /** With `planId`: also run quarantined cases. */
  includeQuarantined: z.boolean().default(false),
  browser: BrowserNameSchema.default('chromium'),
  mode: ExecutionModeSchema.default('replay-heal'),
  attended: z.boolean().default(false),
  buildRef: z.string().optional(),
});

/** Test runs: create (queues jobs), list, get, cancel, rerun failed. Execution happens in the worker pool. */
export const runsRouter = router({
  /** Queues a run: one job per case. Returns the run (status `queued`). */
  create: publicProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    if (input.planId !== undefined) {
      const plan = await requirePlan(ctx, input.planId, project.id);
      return startPlanRun(ctx, project, plan, {
        trigger: 'manual',
        includeQuarantined: input.includeQuarantined,
        attended: input.attended,
        ...(input.buildRef !== undefined ? { buildRef: input.buildRef } : {}),
      });
    }
    if (!input.caseKeys || !input.environment) {
      throw new S1PilotError('INVALID_INPUT', 'Provide planId, or caseKeys and environment');
    }
    const envs = await ctx.repos.environments.listByProject(ctx.db, project.id);
    const environment = envs.find((e) => e.name === input.environment || e.id === input.environment);
    if (!environment) {
      throw new S1PilotError('ENVIRONMENT_NOT_FOUND', `Environment not found: ${input.environment}`, { environment: input.environment });
    }
    const keys = [...new Set(input.caseKeys)];
    const cases = await Promise.all(keys.map((k) => requireCase(ctx, k)));
    const foreign = cases.find((c) => c.projectId !== project.id);
    if (foreign) throw new S1PilotError('CASE_NOT_FOUND', `Case ${foreign.key} is not in project ${project.key}`, { key: foreign.key });
    const config = { environmentId: environment.id, browser: input.browser, mode: input.mode, attended: input.attended };
    return startRun(ctx, project, cases.map((c) => ({ caseId: c.id, config })), input.buildRef);
  }),

  /** Run report: summary, exit-criteria placeholder and result rows (S-046). */
  report: reportProcedure,

  /** Newest runs across all projects (dashboard). */
  recent: publicProcedure.input(RecentInput).query(({ ctx, input }) => recentRuns(ctx, input.limit)),

  /** Runs of a project, newest first, with their summary counts. */
  list: publicProcedure
    .input(
      z.object({
        projectKey: ProjectKeySchema,
        status: RunStatusSchema.optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.projectKey);
      const runs = await ctx.repos.runs.listByProject(ctx.db, project.id, 200);
      const items = runs.filter((r) => input.status === undefined || r.status === input.status).slice(0, input.limit);
      return Promise.all(
        items.map(async (run) => {
          const { config, progress } = await describeRun(ctx, run.id);
          return { ...run, config, progress };
        }),
      );
    }),

  /** One run: status, summary counts, configuration, job states and the case results so far. */
  get: publicProcedure.input(IdSchema).query(async ({ ctx, input }) => {
    const run = await requireRun(ctx, input);
    const { config, jobs, progress, lookup } = await describeRun(ctx, run.id);
    const results = await ctx.repos.results.listCases(ctx.db, run.id);
    return {
      ...run,
      config,
      jobs,
      progress,
      results: await Promise.all(
        results.map(async (r) => ({ ...r, ...(await lookup(r.caseId)) })),
      ),
    };
  }),

  /** Cancels queued jobs and aborts running ones (within seconds). Fails with `INVALID_STATE` when the run already ended. */
  cancel: publicProcedure.input(IdSchema).mutation(async ({ ctx, input }) => {
    const run = await requireRun(ctx, input);
    if (isTerminalRunStatus(run.status)) {
      throw new S1PilotError('INVALID_STATE', `Run already ${run.status}`, { runId: run.id, status: run.status });
    }
    await ctx.runtime.lifecycle.cancel(run.id);
    ctx.runtime.workers.abortRun(run.id);
    return requireRun(ctx, run.id);
  }),

  /**
   * Human control of an attended run for clients without the WebSocket: approve / pickOther / skipStep / pause /
   * resume / abort / takeover / release (S-037). Viewers cannot control runs.
   */
  control: publicProcedure
    .input(z.object({ runId: IdSchema, message: RunControlMessageSchema }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot control runs');
      await ctx.runtime.human.handle(input.runId, ctx.user.id, input.message);
      return { ok: true as const };
    }),

  /** New run with only the cases that failed, were blocked, flaked or errored in `runId`, same configuration. */
  rerunFailed: publicProcedure.input(IdSchema).mutation(async ({ ctx, input }) => {
    const run = await requireRun(ctx, input);
    const project = await ctx.repos.projects.get(ctx.db, run.projectId);
    if (!project) throw new S1PilotError('PROJECT_NOT_FOUND', `Project not found: ${run.projectId}`);
    const { config, jobs } = await describeRun(ctx, run.id);
    if (!config) throw new S1PilotError('INVALID_STATE', 'Run has no jobs to repeat', { runId: run.id });
    const results = await ctx.repos.results.listCases(ctx.db, run.id);
    const failedIds = new Set(results.filter((r) => ['failed', 'blocked', 'flaky'].includes(r.verdict)).map((r) => r.caseId));
    for (const j of jobs) if (j.status === 'failed' && j.caseId) failedIds.add(j.caseId);
    if (failedIds.size === 0) throw new S1PilotError('INVALID_STATE', 'Run has no failed cases', { runId: run.id });
    const { environmentId, browser, mode, attended } = config;
    const rerun = { environmentId, browser, mode, attended };
    return startRun(ctx, project, [...failedIds].map((caseId) => ({ caseId, config: rerun })), run.buildRef);
  }),
});
