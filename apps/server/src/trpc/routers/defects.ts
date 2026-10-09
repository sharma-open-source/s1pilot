import {
  DefectDetailsSchema,
  DefectSeveritySchema,
  DefectStatusSchema,
  IdSchema,
  ProjectKeySchema,
  S1PilotError,
  defectKey,
  matchesDefectQuery,
  newId,
  parseDefectQuery,
  type CaseResult,
  type Defect,
  type DefectDetails,
  type DefectEvidence,
  type StepResult,
} from '@s1pilot/domain';
import { z } from 'zod';

import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireProject } from './helpers.js';
import { startRun } from './runs.js';

/** Statuses that trigger the automatic re-test. */
const RETEST_STATUSES: readonly Defect['status'][] = ['fixed', 'closed'];

/** Verdicts of a result that count as "failing" for a defect. */
const FAILING = ['failed', 'blocked', 'flaky'];

const DetailsInput = DefectDetailsSchema.partial();

/** Writers only: viewers cannot change defects. */
function requireWriter(ctx: Context): void {
  if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot change defects');
}

async function requireDefect(ctx: Context, id: string): Promise<Defect> {
  const d = await ctx.repos.defects.get(ctx.db, id);
  if (!d) throw new S1PilotError('DEFECT_NOT_FOUND', `Defect not found: ${id}`, { id });
  return d;
}

async function requireResult(ctx: Context, id: string): Promise<CaseResult> {
  const r = await ctx.repos.results.getCase(ctx.db, id);
  if (!r) throw new S1PilotError('RESULT_NOT_FOUND', `Result not found: ${id}`, { resultId: id });
  return r;
}

/** First failed / blocked step result. */
const failedStep = (steps: StepResult[]): StepResult | undefined => steps.find((s) => s.status === 'failed' || s.status === 'blocked');

/** Message of the first failing assertion of a step, if any. */
function failureMessage(step: StepResult | undefined): string {
  const a = step?.assertions.find((x) => x.verdict !== 'pass');
  return a?.message ?? '';
}

/**
 * Prefilled defect draft for a result (not stored). Title from case + failure, steps to reproduce from the
 * executed steps' action text, expected vs actual, environment, browser, build ref and screenshot / trace / video links.
 */
export async function draftFromResult(ctx: Context, resultId: string, stepIndex?: number) {
  const result = await requireResult(ctx, resultId);
  const run = await ctx.repos.runs.get(ctx.db, result.runId);
  const project = run ? await ctx.repos.projects.get(ctx.db, run.projectId) : undefined;
  if (!run || !project) throw new S1PilotError('RUN_NOT_FOUND', `Run not found: ${result.runId}`, { runId: result.runId });
  const testCase = await ctx.repos.cases.get(ctx.db, result.caseId);
  const env = result.environmentId ? await ctx.repos.environments.get(ctx.db, result.environmentId) : undefined;
  const steps = await ctx.repos.results.listSteps(ctx.db, result.id);
  const picked = stepIndex !== undefined ? steps.find((s) => s.stepIndex === stepIndex) : failedStep(steps);
  const index = picked?.stepIndex ?? stepIndex ?? steps.at(-1)?.stepIndex ?? 0;
  const caseStep = testCase?.steps[index];
  const reproduce = (testCase?.steps ?? [])
    .slice(0, index + 1)
    .map((s) => s.action)
    .filter((a) => a.length > 0);
  const message = failureMessage(picked);
  const expected = caseStep?.expected ?? picked?.assertions.find((a) => a.verdict !== 'pass')?.assertion ?? '';
  const actual = message || (picked ? `Step ${index + 1} ${picked.status}` : `Result ${result.verdict}`);
  const caseKey = testCase?.key ?? result.caseId;
  const artifacts = await ctx.repos.artifacts.listByCaseResult(ctx.db, result.id);
  const evidence: DefectEvidence[] = [];
  const shot = artifacts.find((a) => a.kind === 'screenshot' && a.stepIndex === index) ?? artifacts.find((a) => a.kind === 'screenshot');
  if (shot) evidence.push({ artifactId: shot.id, kind: 'screenshot', label: `Screenshot, step ${index + 1}` });
  for (const kind of ['trace', 'video'] as const) {
    const a = artifacts.find((x) => x.kind === kind);
    if (a) evidence.push({ artifactId: a.id, kind, label: kind === 'trace' ? 'Playwright trace' : 'Video' });
  }
  const details: DefectDetails = DefectDetailsSchema.parse({
    stepsToReproduce: reproduce,
    expected,
    actual,
    ...(env ? { environment: env.name } : {}),
    browser: result.browser ?? 'chromium',
    ...(run.buildRef ? { buildRef: run.buildRef } : {}),
    evidence,
    sourceKind: 'result',
    sourceLabel: caseKey,
    stepIndex: index,
    retest: true,
  });
  return {
    projectKey: project.key,
    resultId: result.id,
    stepNumber: index + 1,
    title: `${testCase?.title ?? caseKey}${message ? `: ${message}` : ''}`.slice(0, 200),
    severity: 'S2' as const,
    details,
  };
}

async function toRow(ctx: Context, d: Defect) {
  const results = await ctx.repos.defects.linkedResults(ctx.db, d.id);
  const failing = results.filter((r) => FAILING.includes(r.verdict));
  const browsers = [...new Set((failing.length > 0 ? failing : results).map((r) => r.browser ?? 'chromium'))];
  return {
    id: d.id,
    key: defectKey(d),
    title: d.title,
    severity: d.severity,
    status: d.status,
    source: d.details?.sourceLabel ?? null,
    sourceKind: d.details?.sourceKind ?? 'manual',
    failingBrowsers: browsers,
    failingCount: failing.length,
    tracker: d.external ? { provider: d.external.provider, id: d.external.id, url: d.external.url ?? null } : null,
    retest: d.details?.retest ?? false,
    retestRunId: d.details?.retestRunId ?? null,
    createdAt: d.createdAt ?? null,
  };
}

/**
 * Queues the linked failed case instances (same environment and browser) as a new run (`trigger: 'retest'`).
 * Returns the run id, or null when no linked result can be re-run.
 */
export async function queueRetest(ctx: Context, defect: Defect): Promise<string | null> {
  const project = await ctx.repos.projects.get(ctx.db, defect.projectId);
  if (!project) return null;
  const results = (await ctx.repos.defects.linkedResults(ctx.db, defect.id)).filter((r) => FAILING.includes(r.verdict) && r.environmentId);
  const seen = new Set<string>();
  const jobs: Parameters<typeof startRun>[2] = [];
  for (const r of results) {
    const browser = r.browser ?? 'chromium';
    const k = `${r.caseId}|${r.environmentId}|${browser}`;
    if (seen.has(k) || !r.environmentId) continue;
    seen.add(k);
    jobs.push({ caseId: r.caseId, config: { environmentId: r.environmentId, browser, mode: 'replay-heal', attended: false } });
  }
  if (jobs.length === 0) return null;
  const run = await startRun(ctx, project, jobs, defect.details?.buildRef, undefined, [], 'retest');
  return run.id;
}

/** Applies a patch; a transition to fixed / closed with re-test on queues the re-test run. */
async function applyUpdate(
  ctx: Context,
  id: string,
  patch: Partial<Pick<Defect, 'title' | 'severity' | 'status' | 'description'>> & { details?: Partial<DefectDetails> },
) {
  const before = await requireDefect(ctx, id);
  const { details: detailsPatch, ...rest } = patch;
  const details = detailsPatch || before.details ? DefectDetailsSchema.parse({ ...before.details, ...detailsPatch }) : undefined;
  let updated = await ctx.repos.defects.update(ctx.db, id, { ...rest, ...(details ? { details } : {}) });
  const becameDone = RETEST_STATUSES.includes(updated.status) && !RETEST_STATUSES.includes(before.status);
  if (becameDone && updated.details?.retest) {
    const runId = await queueRetest(ctx, updated);
    if (runId) {
      updated = await ctx.repos.defects.update(ctx.db, id, { details: DefectDetailsSchema.parse({ ...updated.details, retestRunId: runId }) });
    }
  }
  return updated;
}

/** `defects` router (S-054): local defect tracking, one-click creation from a result, re-test on close. */
export const defectsRouter = router({
  /** Defects of a project, newest first; `query` uses the shared filter grammar (`status:open severity:S2 tracker:none`). */
  list: publicProcedure
    .input(z.object({ projectKey: ProjectKeySchema, query: z.string().default('') }))
    .query(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.projectKey);
      const ast = parseDefectQuery(input.query);
      const all = await ctx.repos.defects.listByProject(ctx.db, project.id);
      const rows = await Promise.all(all.map((d) => toRow(ctx, d)));
      return {
        total: all.length,
        items: rows.filter((r) =>
          matchesDefectQuery({ key: r.key, title: r.title, status: r.status, severity: r.severity, tracker: r.tracker?.provider }, ast),
        ),
      };
    }),

  /** One defect with its linked results. */
  get: publicProcedure.input(IdSchema).query(async ({ ctx, input }) => {
    const defect = await requireDefect(ctx, input);
    const project = await ctx.repos.projects.get(ctx.db, defect.projectId);
    const results = await ctx.repos.defects.linkedResults(ctx.db, defect.id);
    const linked = await Promise.all(
      results.map(async (r) => {
        const c = await ctx.repos.cases.get(ctx.db, r.caseId);
        return { id: r.id, runId: r.runId, caseKey: c?.key ?? r.caseId, caseTitle: c?.title ?? '', verdict: r.verdict, browser: r.browser ?? 'chromium' };
      }),
    );
    return { defect, key: defectKey(defect), projectKey: project?.key ?? '', linked };
  }),

  /** Prefilled draft for a result (nothing is stored). */
  createFromResult: publicProcedure
    .input(z.object({ resultId: IdSchema, stepIndex: z.number().int().min(0).optional() }))
    .query(({ ctx, input }) => draftFromResult(ctx, input.resultId, input.stepIndex)),

  /** Stores a defect (status `open` unless `draft`), optionally linked to results. */
  create: publicProcedure
    .input(
      z.object({
        projectKey: ProjectKeySchema,
        title: z.string().trim().min(1).max(300),
        severity: DefectSeveritySchema,
        status: DefectStatusSchema.default('open'),
        description: z.string().max(10_000).optional(),
        details: DetailsInput.default({}),
        resultIds: z.array(IdSchema).default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireWriter(ctx);
      const project = await requireProject(ctx, input.projectKey);
      for (const id of input.resultIds) await requireResult(ctx, id);
      const defect = await ctx.repos.defects.create(ctx.db, {
        id: newId(),
        projectId: project.id,
        title: input.title,
        severity: input.severity,
        status: input.status,
        ...(input.description ? { description: input.description } : {}),
        details: DefectDetailsSchema.parse({ sourceKind: input.resultIds.length > 0 ? 'result' : 'manual', ...input.details }),
        linkedResultIds: [...new Set(input.resultIds)],
      });
      ctx.runtime.live.notifyWorkspace();
      return defect;
    }),

  /** Edits title, severity, status, description or the re-test flag. Moving to fixed / closed with re-test on queues the re-test run. */
  update: publicProcedure
    .input(
      z.object({
        id: IdSchema,
        title: z.string().trim().min(1).max(300).optional(),
        severity: DefectSeveritySchema.optional(),
        status: DefectStatusSchema.optional(),
        description: z.string().max(10_000).optional(),
        details: DetailsInput.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireWriter(ctx);
      const { id, ...patch } = input;
      const updated = await applyUpdate(ctx, id, patch);
      ctx.runtime.live.notifyWorkspace();
      return updated;
    }),

  /** Links another result to the defect (idempotent). */
  linkResult: publicProcedure.input(z.object({ defectId: IdSchema, resultId: IdSchema })).mutation(async ({ ctx, input }) => {
    requireWriter(ctx);
    await requireDefect(ctx, input.defectId);
    await requireResult(ctx, input.resultId);
    await ctx.repos.defects.link(ctx.db, input.defectId, input.resultId);
    return requireDefect(ctx, input.defectId);
  }),

  /** Closes the defect; with re-test on, the linked failed case instances are queued as a `retest` run. */
  close: publicProcedure.input(IdSchema).mutation(async ({ ctx, input }) => {
    requireWriter(ctx);
    const updated = await applyUpdate(ctx, input, { status: 'closed' });
    ctx.runtime.live.notifyWorkspace();
    return updated;
  }),
});
