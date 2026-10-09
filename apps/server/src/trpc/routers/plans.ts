import { listCasesByQuery } from '@s1pilot/db';
import {
  IdSchema,
  ProjectKeySchema,
  S1PilotError,
  TestPlanSchema,
  newId,
  parseQuery,
  type Environment,
  type MatrixEntry,
  type Project,
  type TestCase,
  type TestPlan,
} from '@s1pilot/domain';
import { z } from 'zod';

import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireProject } from './helpers.js';

/** Plan content as sent by clients: everything but the server-managed fields. */
export const PlanDraftSchema = TestPlanSchema.omit({ id: true, projectId: true, createdAt: true, updatedAt: true });
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

/** Fallback durations when a project has no history for a mode (ms). */
const DEFAULT_REPLAY_MS = 15_000;
const DEFAULT_EXPLORE_MS = 90_000;

/** One environment x browser (x device) a plan runs against. */
export interface PlanCombo {
  environmentId: string;
  environmentName: string;
  browser: MatrixEntry['browser'];
  device?: string;
}

/** A matrix entry that cannot run, with the reason. */
export interface SkippedCombo {
  environmentId: string;
  browser: MatrixEntry['browser'];
  device?: string;
  reason: string;
}

/** What a plan turns into. `jobs` is cases x combos; `executions` also multiplies by parameter rows. */
export interface PlanExpansion {
  /** Cases the selection matched (including quarantined ones). */
  matched: TestCase[];
  /** Matched cases that will run (quarantined removed unless included). */
  runnable: TestCase[];
  quarantined: number;
  learned: number;
  notLearned: number;
  combos: PlanCombo[];
  skippedCombos: SkippedCombo[];
  jobs: number;
  executions: number;
  estimateMin: number;
}

/**
 * Ids of quarantined cases in a project.
 * TODO(S-051): read the quarantine state once flaky detection / quarantine exists.
 */
export async function quarantinedCaseIds(ctx: Context, projectId: string): Promise<string[]> {
  void ctx;
  void projectId;
  return [];
}

/**
 * True when the environment accepts the matrix entry. Read-only environments (production by default) only
 * accept the browsers/devices listed on the environment; other environments accept any entry.
 */
export function comboAllowed(env: Environment, entry: MatrixEntry): boolean {
  if (!env.readOnly) return true;
  return env.browsers.some((b) => b.browser === entry.browser && (b.device ?? undefined) === (entry.device ?? undefined));
}

async function resolveSelection(ctx: Context, project: Project, plan: PlanDraft, quarantinedIds: string[]): Promise<TestCase[]> {
  const sel = plan.selection;
  if (sel.kind === 'query') {
    return listCasesByQuery(ctx.db, project.id, parseQuery(sel.query), quarantinedIds);
  }
  const out: TestCase[] = [];
  const seen = new Set<string>();
  for (const id of sel.caseIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const c = await ctx.repos.cases.get(ctx.db, id);
    if (c && c.projectId === project.id) out.push(c);
  }
  return out;
}

/** Validates the parts of a draft that depend on the project: query syntax, case ids, environments, matrix. */
export async function validatePlanDraft(ctx: Context, project: Project, plan: PlanDraft): Promise<Map<string, Environment>> {
  if (plan.selection.kind === 'query') parseQuery(plan.selection.query);
  else {
    for (const id of plan.selection.caseIds) {
      const c = await ctx.repos.cases.get(ctx.db, id);
      if (!c || c.projectId !== project.id) throw new S1PilotError('CASE_NOT_FOUND', `Case not found in project: ${id}`, { id });
    }
  }
  const envs = new Map((await ctx.repos.environments.listByProject(ctx.db, project.id)).map((e) => [e.id, e]));
  for (const entry of plan.matrix) {
    const env = envs.get(entry.environmentId);
    if (!env) throw new S1PilotError('ENVIRONMENT_NOT_FOUND', `Environment not found: ${entry.environmentId}`, { id: entry.environmentId });
    if (!comboAllowed(env, entry)) {
      throw new S1PilotError(
        'MATRIX_INVALID',
        `Environment ${env.name} is read-only and does not allow ${entry.browser}${entry.device ? ` (${entry.device})` : ''}`,
        { environmentId: env.id, browser: entry.browser },
      );
    }
  }
  return envs;
}

/**
 * Expands a plan: selected cases x matrix combos (x parameter rows for `executions`). Quarantined cases are
 * skipped unless `includeQuarantined`; matrix entries a read-only environment does not allow are skipped.
 * Preview and run creation both use this, so their counts agree.
 */
export async function expandPlan(
  ctx: Context,
  project: Project,
  plan: PlanDraft,
  opts: { includeQuarantined?: boolean } = {},
): Promise<PlanExpansion> {
  const quarantinedIds = await quarantinedCaseIds(ctx, project.id);
  const quarantinedSet = new Set(quarantinedIds);
  const matched = await resolveSelection(ctx, project, plan, quarantinedIds);
  const runnable = opts.includeQuarantined ? matched : matched.filter((c) => !quarantinedSet.has(c.id));

  const envs = new Map((await ctx.repos.environments.listByProject(ctx.db, project.id)).map((e) => [e.id, e]));
  const combos: PlanCombo[] = [];
  const skippedCombos: SkippedCombo[] = [];
  const seen = new Set<string>();
  for (const entry of plan.matrix) {
    const key = `${entry.environmentId}|${entry.browser}|${entry.device ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const env = envs.get(entry.environmentId);
    const device = entry.device !== undefined ? { device: entry.device } : {};
    if (!env) {
      skippedCombos.push({ environmentId: entry.environmentId, browser: entry.browser, ...device, reason: 'environment not found' });
    } else if (!comboAllowed(env, entry)) {
      skippedCombos.push({ environmentId: env.id, browser: entry.browser, ...device, reason: `${env.name} is read-only and does not allow this browser` });
    } else {
      combos.push({ environmentId: env.id, environmentName: env.name, browser: entry.browser, ...device });
    }
  }

  // A case is "learned" when it has a script in every environment of the (allowed) matrix.
  const envIds = [...new Set(combos.map((c) => c.environmentId))];
  const learnedIds = new Set<string>();
  for (const c of matched) {
    const scripts = await ctx.repos.learnedScripts.listByCase(ctx.db, c.id);
    if (envIds.length > 0 && envIds.every((id) => scripts.some((s) => s.environmentId === id))) learnedIds.add(c.id);
  }

  const avg = await ctx.repos.results.avgDurationByMode(ctx.db, project.id);
  const replayMs = mean([avg.get('replay'), avg.get('healed')]) ?? DEFAULT_REPLAY_MS;
  const exploreMs = avg.get('explore') ?? DEFAULT_EXPLORE_MS;
  let executions = 0;
  let totalMs = 0;
  for (const c of runnable) {
    const rows = Math.max(1, c.parameters.length);
    const perRow = plan.mode !== 'explore' && learnedIds.has(c.id) ? replayMs : exploreMs;
    executions += rows * combos.length;
    totalMs += rows * combos.length * perRow;
  }
  const lanes = Math.max(1, Math.min(plan.parallelism, executions));
  const estimateMin = executions === 0 ? 0 : Math.round((totalMs / lanes / 60_000) * 10) / 10;

  return {
    matched,
    runnable,
    quarantined: matched.filter((c) => quarantinedSet.has(c.id)).length,
    learned: matched.filter((c) => learnedIds.has(c.id)).length,
    notLearned: matched.filter((c) => !learnedIds.has(c.id)).length,
    combos,
    skippedCombos,
    jobs: runnable.length * combos.length,
    executions,
    estimateMin,
  };
}

function mean(xs: (number | undefined)[]): number | undefined {
  const v = xs.filter((x): x is number => x !== undefined);
  return v.length === 0 ? undefined : v.reduce((a, b) => a + b, 0) / v.length;
}

/** Loads a plan, checking it belongs to the project. */
export async function requirePlan(ctx: Context, id: string, projectId?: string): Promise<TestPlan> {
  const plan = await ctx.repos.plans.get(ctx.db, id);
  if (!plan || (projectId !== undefined && plan.projectId !== projectId)) {
    throw new S1PilotError('PLAN_NOT_FOUND', `Plan not found: ${id}`, { id });
  }
  return plan;
}

async function withLastRun(ctx: Context, plan: TestPlan) {
  const [last] = await ctx.repos.runs.listByPlan(ctx.db, plan.id, 1);
  return {
    ...plan,
    lastRun: last ? { id: last.id, status: last.status, startedAt: last.startedAt ?? null, summary: last.summary } : null,
  };
}

function requireWriter(ctx: Context): void {
  if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot change plans');
}

async function assertNameFree(ctx: Context, projectId: string, name: string, exceptId?: string): Promise<void> {
  const all = await ctx.repos.plans.listByProject(ctx.db, projectId);
  if (all.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) {
    throw new S1PilotError('PLAN_DUPLICATE', `A plan named "${name}" already exists`, { name });
  }
}

const ProjectDraft = PlanDraftSchema.extend({ projectKey: ProjectKeySchema });

/** Test plans: CRUD, preview, and (via `runs.create({ planId })`) execution. */
export const plansRouter = router({
  /** Plans of a project by name, each with its latest run. */
  list: publicProcedure.input(z.object({ projectKey: ProjectKeySchema })).query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const plans = await ctx.repos.plans.listByProject(ctx.db, project.id);
    return Promise.all(plans.map((p) => withLastRun(ctx, p)));
  }),

  get: publicProcedure.input(IdSchema).query(async ({ ctx, input }) => withLastRun(ctx, await requirePlan(ctx, input))),

  create: publicProcedure.input(ProjectDraft).mutation(async ({ ctx, input }) => {
    requireWriter(ctx);
    const { projectKey, ...draft } = input;
    const project = await requireProject(ctx, projectKey);
    await validatePlanDraft(ctx, project, draft);
    await assertNameFree(ctx, project.id, draft.name);
    return ctx.repos.plans.create(ctx.db, { ...draft, id: newId(), projectId: project.id });
  }),

  update: publicProcedure
    .input(z.object({ id: IdSchema, patch: PlanDraftSchema.partial() }))
    .mutation(async ({ ctx, input }) => {
      requireWriter(ctx);
      const existing = await requirePlan(ctx, input.id);
      const project = await ctx.repos.projects.get(ctx.db, existing.projectId);
      if (!project) throw new S1PilotError('PROJECT_NOT_FOUND', `Project not found: ${existing.projectId}`);
      const merged = PlanDraftSchema.parse({ ...PlanDraftSchema.parse(existing), ...input.patch });
      await validatePlanDraft(ctx, project, merged);
      if (merged.name !== existing.name) await assertNameFree(ctx, project.id, merged.name, existing.id);
      return ctx.repos.plans.update(ctx.db, existing.id, merged);
    }),

  delete: publicProcedure.input(IdSchema).mutation(async ({ ctx, input }) => {
    requireWriter(ctx);
    await requirePlan(ctx, input);
    await ctx.repos.plans.delete(ctx.db, input);
    return { ok: true as const };
  }),

  /**
   * Dry run of a plan draft: how many cases match, how many have learned scripts, how many are quarantined,
   * how many executions (cases x parameter rows x matrix combos) a run would queue and a time estimate.
   */
  preview: publicProcedure
    .input(ProjectDraft.extend({ includeQuarantined: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      const { projectKey, includeQuarantined, ...draft } = input;
      const project = await requireProject(ctx, projectKey);
      if (draft.selection.kind === 'query') parseQuery(draft.selection.query);
      const x = await expandPlan(ctx, project, draft, { includeQuarantined });
      return {
        matched: x.matched.length,
        learned: x.learned,
        notLearned: x.notLearned,
        quarantined: x.quarantined,
        executions: x.executions,
        estimateMin: x.estimateMin,
        jobs: x.jobs,
        combos: x.combos,
        skippedCombos: x.skippedCombos,
        cases: x.matched.slice(0, 200).map((c) => ({ id: c.id, key: c.key, title: c.title, priority: c.priority })),
      };
    }),
});
