import { IdSchema, ProjectKeySchema, S1PilotError, StepSchema, newId, type SharedStep, type Step, type TestCase } from '@s1pilot/domain';
import { z } from 'zod';

import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireProject } from './helpers.js';

/** Marker action of reference steps (matches the engine's `FLOW_REF_PREFIX`). */
const FLOW_REF_PREFIX = 'Run flow ';

async function requireSharedStep(ctx: Context, id: string): Promise<SharedStep> {
  const s = await ctx.repos.sharedSteps.get(ctx.db, id);
  if (!s) throw new S1PilotError('SHARED_STEP_NOT_FOUND', `Shared step not found: ${id}`, { id });
  return s;
}

function requireWriter(ctx: Context): void {
  if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot change shared steps');
}

/** True when `ref` (a step's `sharedStepId`, a `flow:` precondition or a login's flow) names `s`; runs look flows up by id or name. */
const refersTo = (ref: string | undefined, s: Pick<SharedStep, 'id' | 'name'>): boolean => ref !== undefined && (ref === s.id || ref === s.name);

/** Where a shared step is used. */
export interface SharedStepUsage {
  /** Keys of cases with a step that runs it. */
  steps: string[];
  /** Keys of cases that run it as a `flow:` precondition. */
  preconditions: string[];
  /** Names of other shared steps that include it. */
  flows: string[];
  /** Environment logins (`environment / login`) that run it. */
  logins: string[];
}

interface ProjectRefs {
  cases: TestCase[];
  flows: SharedStep[];
  logins: Array<{ label: string; flowId?: string | undefined }>;
}

async function projectRefs(ctx: Context, projectId: string): Promise<ProjectRefs> {
  const [cases, flows, envs] = await Promise.all([
    ctx.repos.cases.list(ctx.db, { projectId }),
    ctx.repos.sharedSteps.listByProject(ctx.db, projectId),
    ctx.repos.environments.listByProject(ctx.db, projectId),
  ]);
  const logins = (
    await Promise.all(envs.map(async (e) => (await ctx.repos.authSetups.listByEnvironment(ctx.db, e.id)).map((a) => ({ label: `${e.name} / ${a.name}`, flowId: a.flowId }))))
  ).flat();
  return { cases, flows, logins };
}

function usageOf(s: SharedStep, refs: ProjectRefs): SharedStepUsage {
  return {
    steps: refs.cases.filter((c) => c.steps.some((st) => refersTo(st.sharedStepId, s))).map((c) => c.key),
    preconditions: refs.cases.filter((c) => c.preconditions.some((p) => 'flow' in p && refersTo(p.flow, s))).map((c) => c.key),
    flows: refs.flows.filter((f) => f.id !== s.id && f.steps.some((st) => refersTo(st.sharedStepId, s))).map((f) => f.name),
    logins: refs.logins.filter((l) => refersTo(l.flowId, s)).map((l) => l.label),
  };
}

/** Number of distinct cases using the shared step (as a step or a precondition). */
const caseCount = (u: SharedStepUsage): number => new Set([...u.steps, ...u.preconditions]).size;

async function assertUniqueName(ctx: Context, projectId: string, name: string, exceptId?: string): Promise<void> {
  const all = await ctx.repos.sharedSteps.listByProject(ctx.db, projectId);
  if (all.some((s) => s.name === name && s.id !== exceptId)) {
    throw new S1PilotError('CONFLICT', `A shared step named "${name}" already exists`, { name });
  }
}

/**
 * Checks the references inside `candidate`'s steps: every referenced shared step exists in the project, and
 * none leads back to `candidate` (a flow must not include itself, directly or through another flow).
 */
function assertReferences(candidate: SharedStep, flows: SharedStep[]): void {
  const others = flows.filter((f) => f.id !== candidate.id);
  const all = [candidate, ...others];
  const find = (ref: string) => all.find((f) => refersTo(ref, f));
  const visit = (flow: SharedStep, chain: string[]): void => {
    for (const st of flow.steps) {
      if (st.sharedStepId === undefined) continue;
      const next = find(st.sharedStepId);
      if (!next) throw new S1PilotError('SHARED_STEP_INVALID', `Step "${st.action}" runs a shared step that does not exist (${st.sharedStepId})`, { flow: st.sharedStepId });
      if (next.id === candidate.id) {
        throw new S1PilotError('SHARED_STEP_INVALID', `"${candidate.name}" would include itself (${[...chain, next.name].join(' → ')})`, { flow: candidate.name });
      }
      if (!chain.includes(next.name)) visit(next, [...chain, next.name]);
    }
  };
  visit(candidate, [candidate.name]);
}

/** Rewrites name-based references (`flow: old`, `sharedStepId: old`) after a rename; id-based ones stay valid. */
function renameRefs(steps: Step[], from: string, to: string): Step[] | undefined {
  if (!steps.some((st) => st.sharedStepId === from)) return undefined;
  return steps.map((st) =>
    st.sharedStepId === from ? { ...st, sharedStepId: to, action: st.action === `${FLOW_REF_PREFIX}${from}` ? `${FLOW_REF_PREFIX}${to}` : st.action } : st,
  );
}

const NameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(120)
  .refine((n) => !/[\r\n]/.test(n), 'The name must be on one line');
/** `{param}` names as used in step text. */
const ParamSchema = z.string().trim().regex(/^[A-Za-z_][\w-]*$/, 'Use letters, digits, "_" or "-" for parameters, for example role');
const ParamsSchema = z
  .array(ParamSchema)
  .max(50)
  .refine((ps) => new Set(ps).size === ps.length, 'Each parameter name must be unique');

/** Reusable step sequences ("flows"). */
export const sharedStepsRouter = router({
  /** All shared steps of a project with where each is used. `usageCount` counts cases (steps or preconditions). */
  list: publicProcedure.input(z.object({ projectKey: ProjectKeySchema })).query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const refs = await projectRefs(ctx, project.id);
    return refs.flows.map((s) => {
      const usage = usageOf(s, refs);
      return { ...s, usage, usageCount: caseCount(usage) };
    });
  }),

  /** One shared step; `usedBy` = keys of cases using it (as a step or a precondition). */
  get: publicProcedure.input(z.object({ id: IdSchema })).query(async ({ ctx, input }) => {
    const s = await requireSharedStep(ctx, input.id);
    const usage = usageOf(s, await projectRefs(ctx, s.projectId));
    const usedBy = [...new Set([...usage.steps, ...usage.preconditions])];
    return { ...s, usage, usageCount: usedBy.length, usedBy };
  }),

  create: publicProcedure
    .input(
      z.object({
        projectKey: ProjectKeySchema,
        name: NameSchema,
        params: ParamsSchema.default([]),
        steps: z.array(StepSchema).min(1, 'A shared step needs at least one step'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireWriter(ctx);
      const project = await requireProject(ctx, input.projectKey);
      await assertUniqueName(ctx, project.id, input.name);
      const s: SharedStep = { id: newId(), projectId: project.id, name: input.name, params: input.params, steps: input.steps };
      assertReferences(s, await ctx.repos.sharedSteps.listByProject(ctx.db, project.id));
      return ctx.repos.sharedSteps.create(ctx.db, s);
    }),

  /**
   * Changes name, parameters and/or steps. A rename also rewrites references that use the old name
   * (`flow:` preconditions, name-based steps in cases and other flows, environment logins); each changed case
   * gets a new version.
   */
  update: publicProcedure
    .input(
      z.object({
        id: IdSchema,
        name: NameSchema.optional(),
        params: ParamsSchema.optional(),
        steps: z.array(StepSchema).min(1, 'A shared step needs at least one step').optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireWriter(ctx);
      const existing = await requireSharedStep(ctx, input.id);
      if (input.name !== undefined) await assertUniqueName(ctx, existing.projectId, input.name, existing.id);
      const { id, ...rest } = input;
      const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<Pick<SharedStep, 'name' | 'params' | 'steps'>>;
      const next: SharedStep = { ...existing, ...patch };
      const flows = await ctx.repos.sharedSteps.listByProject(ctx.db, existing.projectId);
      assertReferences(next, flows);
      const saved = await ctx.repos.sharedSteps.update(ctx.db, id, patch);

      const from = existing.name;
      const to = saved.name;
      if (from !== to) {
        const refs = await projectRefs(ctx, existing.projectId);
        for (const c of refs.cases) {
          const steps = renameRefs(c.steps, from, to);
          const renamedPre = c.preconditions.some((p) => 'flow' in p && p.flow === from);
          if (steps === undefined && !renamedPre) continue;
          await ctx.repos.cases.update(ctx.db, c.id, {
            ...(steps !== undefined ? { steps } : {}),
            ...(renamedPre ? { preconditions: c.preconditions.map((p) => ('flow' in p && p.flow === from ? { flow: to } : p)) } : {}),
          });
        }
        for (const f of refs.flows) {
          const steps = f.id === id ? undefined : renameRefs(f.steps, from, to);
          if (steps !== undefined) await ctx.repos.sharedSteps.update(ctx.db, f.id, { steps });
        }
        const envs = await ctx.repos.environments.listByProject(ctx.db, existing.projectId);
        for (const e of envs) {
          for (const a of await ctx.repos.authSetups.listByEnvironment(ctx.db, e.id)) {
            if (a.flowId !== from) continue;
            await ctx.repos.authSetups.upsert(ctx.db, { environmentId: e.id, name: a.name, kind: a.kind, flowId: to, ...(a.validation ? { validation: a.validation } : {}) });
          }
        }
      }
      return saved;
    }),

  /** Deletes an unused shared step. `CONFLICT` (with `details.usage`) while any case, flow or login still runs it. */
  delete: publicProcedure.input(z.object({ id: IdSchema })).mutation(async ({ ctx, input }) => {
    requireWriter(ctx);
    const s = await requireSharedStep(ctx, input.id);
    const usage = usageOf(s, await projectRefs(ctx, s.projectId));
    const parts = [
      usage.steps.length > 0 ? `cases ${usage.steps.join(', ')}` : '',
      usage.preconditions.length > 0 ? `preconditions of ${usage.preconditions.join(', ')}` : '',
      usage.flows.length > 0 ? `shared steps ${usage.flows.join(', ')}` : '',
      usage.logins.length > 0 ? `logins ${usage.logins.join(', ')}` : '',
    ].filter((p) => p !== '');
    if (parts.length > 0) {
      throw new S1PilotError('CONFLICT', `"${s.name}" is still used by ${parts.join('; ')}. Remove it there first.`, { usage });
    }
    await ctx.repos.sharedSteps.delete(ctx.db, s.id);
    return { id: s.id, name: s.name };
  }),
});
