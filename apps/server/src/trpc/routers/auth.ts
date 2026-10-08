import { AuthNameSchema, AuthValidationSchema, IdSchema, ProjectKeySchema, S1PilotError, type AuthSetup } from '@s1pilot/domain';
import { z } from 'zod';

import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireEnvironment, requireProject } from './helpers.js';

/** Which environment: explicit id, or the default environment of a project. */
const EnvTarget = z.object({ environmentId: IdSchema.optional(), projectKey: ProjectKeySchema.optional() });
const SetupTarget = EnvTarget.extend({ id: IdSchema.optional(), name: AuthNameSchema.optional() });

async function resolveEnvironment(ctx: Context, target: z.infer<typeof EnvTarget>) {
  if (target.environmentId) return requireEnvironment(ctx, target.environmentId);
  if (target.projectKey) {
    const project = await requireProject(ctx, target.projectKey);
    if (!project.defaultEnvironmentId) throw new S1PilotError('ENVIRONMENT_NOT_FOUND', `Project ${project.key} has no environment`);
    return requireEnvironment(ctx, project.defaultEnvironmentId);
  }
  throw new S1PilotError('INVALID_INPUT', 'environmentId or projectKey is required');
}

async function resolveSetup(ctx: Context, target: z.infer<typeof SetupTarget>): Promise<AuthSetup> {
  if (target.id) {
    const setup = await ctx.repos.authSetups.get(ctx.db, target.id);
    if (!setup) throw new S1PilotError('AUTH_NOT_FOUND', `Auth setup not found: ${target.id}`, { id: target.id });
    return setup;
  }
  if (!target.name) throw new S1PilotError('INVALID_INPUT', 'id or name is required');
  const env = await resolveEnvironment(ctx, target);
  const setup = await ctx.repos.authSetups.getByName(ctx.db, env.id, target.name);
  if (!setup) throw new S1PilotError('AUTH_NOT_FOUND', `Auth setup not found: ${target.name}`, { name: target.name });
  return setup;
}

/** Saved logins per environment (S-038). Responses never contain a storage state. */
export const authRouter = router({
  list: publicProcedure.input(EnvTarget).query(async ({ ctx, input }) => {
    const env = await resolveEnvironment(ctx, input);
    return ctx.repos.authSetups.listByEnvironment(ctx.db, env.id);
  }),

  /** Creates (or reuses) a `recorded` setup and opens the headed browser at the environment's base URL. */
  record: publicProcedure
    .input(EnvTarget.extend({ name: AuthNameSchema, validation: AuthValidationSchema.optional() }))
    .mutation(async ({ ctx, input }) => {
      const env = await resolveEnvironment(ctx, input);
      const setup = await ctx.repos.authSetups.upsert(ctx.db, {
        environmentId: env.id,
        name: input.name,
        kind: 'recorded',
        ...(input.validation ? { validation: input.validation } : {}),
      });
      await ctx.runtime.auth.startRecording(setup, env);
      return { ...setup, recording: true as const };
    }),

  /** The user pressed Done: the browser's storage state is stored encrypted and the setup becomes `valid`. */
  finishRecording: publicProcedure.input(SetupTarget).mutation(async ({ ctx, input }) => {
    const setup = await resolveSetup(ctx, input);
    return ctx.runtime.auth.finishRecording(setup.id);
  }),

  /** Defines (or updates) a `flow` login: a shared step run by the engine at refresh time. Additive to the spec's list. */
  saveFlow: publicProcedure
    .input(EnvTarget.extend({ name: AuthNameSchema, flowId: z.string().min(1), validation: AuthValidationSchema.optional() }))
    .mutation(async ({ ctx, input }) => {
      const env = await resolveEnvironment(ctx, input);
      return ctx.repos.authSetups.upsert(ctx.db, {
        environmentId: env.id,
        name: input.name,
        kind: 'flow',
        flowId: input.flowId,
        ...(input.validation ? { validation: input.validation } : {}),
      });
    }),

  /** Runs the login flow again and stores the new state. */
  refresh: publicProcedure.input(SetupTarget).mutation(async ({ ctx, input }) => {
    const setup = await resolveSetup(ctx, input);
    return ctx.runtime.auth.refresh(setup.id);
  }),

  /** Checks the stored state against the validation page; sets the status to `valid` or `expired`. */
  validate: publicProcedure.input(SetupTarget).mutation(async ({ ctx, input }) => {
    const setup = await resolveSetup(ctx, input);
    return ctx.runtime.auth.validate(setup.id);
  }),

  delete: publicProcedure.input(SetupTarget).mutation(async ({ ctx, input }) => {
    const setup = await resolveSetup(ctx, input);
    await ctx.runtime.auth.cancelRecording(setup.id);
    await ctx.repos.authSetups.delete(ctx.db, setup.id);
    return { deleted: true as const, id: setup.id };
  }),
});
