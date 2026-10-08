import { IdSchema, ProjectKeySchema, S1PilotError, StepSchema, newId, type SharedStep } from '@s1pilot/domain';
import { z } from 'zod';

import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireProject } from './helpers.js';

async function requireSharedStep(ctx: Context, id: string): Promise<SharedStep> {
  const s = await ctx.repos.sharedSteps.get(ctx.db, id);
  if (!s) throw new S1PilotError('SHARED_STEP_NOT_FOUND', `Shared step not found: ${id}`, { id });
  return s;
}

/** Keys of the project's cases whose steps reference the shared step. */
async function usedBy(ctx: Context, s: SharedStep): Promise<string[]> {
  const cases = await ctx.repos.cases.list(ctx.db, { projectId: s.projectId });
  return cases.filter((c) => c.steps.some((st) => st.sharedStepId === s.id)).map((c) => c.key);
}

async function assertUniqueName(ctx: Context, projectId: string, name: string, exceptId?: string): Promise<void> {
  const all = await ctx.repos.sharedSteps.listByProject(ctx.db, projectId);
  if (all.some((s) => s.name === name && s.id !== exceptId)) {
    throw new S1PilotError('CONFLICT', `A shared step named "${name}" already exists`, { name });
  }
}

const NameSchema = z.string().trim().min(1);

/** Reusable step sequences ("flows"). */
export const sharedStepsRouter = router({
  /** All shared steps of a project with the number of cases using each. */
  list: publicProcedure.input(z.object({ projectKey: ProjectKeySchema })).query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const [steps, cases] = await Promise.all([
      ctx.repos.sharedSteps.listByProject(ctx.db, project.id),
      ctx.repos.cases.list(ctx.db, { projectId: project.id }),
    ]);
    return steps.map((s) => ({
      ...s,
      usageCount: cases.filter((c) => c.steps.some((st) => st.sharedStepId === s.id)).length,
    }));
  }),

  get: publicProcedure.input(z.object({ id: IdSchema })).query(async ({ ctx, input }) => {
    const s = await requireSharedStep(ctx, input.id);
    const cases = await usedBy(ctx, s);
    return { ...s, usageCount: cases.length, usedBy: cases };
  }),

  create: publicProcedure
    .input(
      z.object({
        projectKey: ProjectKeySchema,
        name: NameSchema,
        params: z.array(z.string().min(1)).default([]),
        steps: z.array(StepSchema).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.projectKey);
      await assertUniqueName(ctx, project.id, input.name);
      return ctx.repos.sharedSteps.create(ctx.db, {
        id: newId(),
        projectId: project.id,
        name: input.name,
        params: input.params,
        steps: input.steps,
      });
    }),

  update: publicProcedure
    .input(
      z.object({
        id: IdSchema,
        name: NameSchema.optional(),
        params: z.array(z.string().min(1)).optional(),
        steps: z.array(StepSchema).min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await requireSharedStep(ctx, input.id);
      if (input.name !== undefined) await assertUniqueName(ctx, existing.projectId, input.name, existing.id);
      const { id, ...rest } = input;
      const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      return ctx.repos.sharedSteps.update(ctx.db, id, patch);
    }),
});
