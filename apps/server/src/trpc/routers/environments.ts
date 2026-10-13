import { EnvironmentSchema, IdSchema, ProjectKeySchema, S1PilotError, newId, plainSecretLikeKeys, type Variable } from '@s1pilot/domain';
import { z } from 'zod';

import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { maskEnvironment, requireEnvironment, requireProject } from './helpers.js';

const EnvFields = EnvironmentSchema.omit({ id: true, projectId: true });
const EnvPatch = EnvFields.partial();

/** Max `revealSecret` calls per user per window. */
export const REVEAL_LIMIT = 10;
export const REVEAL_WINDOW_MS = 60_000;

const revealLog = new WeakMap<object, Map<string, number[]>>();

/** Sliding-window limiter per database + user; throws `RATE_LIMITED`. */
function checkRevealRate(ctx: Context): void {
  let perDb = revealLog.get(ctx.db);
  if (!perDb) revealLog.set(ctx.db, (perDb = new Map()));
  const now = Date.now();
  const recent = (perDb.get(ctx.user.id) ?? []).filter((t) => now - t < REVEAL_WINDOW_MS);
  if (recent.length >= REVEAL_LIMIT) {
    throw new S1PilotError('RATE_LIMITED', 'Too many secret reveals; try again in a minute');
  }
  recent.push(now);
  perDb.set(ctx.user.id, recent);
}

/** Rejects plain variables named like secrets (`PASSWORD`): their values would be shown and sent to models. */
function assertNoPlainSecrets(variables: readonly Variable[] | undefined): void {
  const keys = plainSecretLikeKeys(variables ?? []);
  if (keys.length > 0) {
    throw new S1PilotError(
      'INVALID_INPUT',
      `${keys.map((k) => `"${k}"`).join(', ')} ${keys.length === 1 ? 'looks' : 'look'} like a password or token: store ${keys.length === 1 ? 'it' : 'them'} as a secret, not a plain variable`,
      { keys },
    );
  }
}

/** Environments and their variables. Secret values are only ever returned by `revealSecret`. */
export const environmentsRouter = router({
  list: publicProcedure.input(z.object({ projectKey: ProjectKeySchema })).query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    return (await ctx.repos.environments.listByProject(ctx.db, project.id)).map(maskEnvironment);
  }),

  get: publicProcedure.input(z.object({ id: IdSchema })).query(async ({ ctx, input }) => {
    return maskEnvironment(await requireEnvironment(ctx, input.id));
  }),

  create: publicProcedure.input(EnvFields.extend({ projectKey: ProjectKeySchema })).mutation(async ({ ctx, input }) => {
    const { projectKey, ...fields } = input;
    assertNoPlainSecrets(fields.variables);
    const project = await requireProject(ctx, projectKey);
    const existing = await ctx.repos.environments.listByProject(ctx.db, project.id);
    if (existing.some((e) => e.name === fields.name)) {
      throw new S1PilotError('CONFLICT', `Environment "${fields.name}" already exists`, { name: fields.name });
    }
    const env = await ctx.repos.environments.create(ctx.db, { ...fields, id: newId(), projectId: project.id });
    if (!project.defaultEnvironmentId) {
      await ctx.repos.projects.update(ctx.db, project.id, { defaultEnvironmentId: env.id });
    }
    return maskEnvironment(env);
  }),

  /** Patches an environment. When `variables` is given it replaces the set; secrets sent without a value keep theirs. */
  update: publicProcedure.input(z.object({ id: IdSchema, patch: EnvPatch })).mutation(async ({ ctx, input }) => {
    await requireEnvironment(ctx, input.id);
    assertNoPlainSecrets(input.patch.variables);
    return maskEnvironment(await ctx.repos.environments.update(ctx.db, input.id, input.patch));
  }),

  /** Returns one secret in plaintext. Audit-logged (key and caller only, never the value) and rate-limited. */
  revealSecret: publicProcedure
    .input(z.object({ envId: IdSchema, key: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === 'viewer' || ctx.user.role === 'tester') {
        throw new S1PilotError('FORBIDDEN', 'Only admins and leads can reveal secrets');
      }
      const env = await requireEnvironment(ctx, input.envId);
      checkRevealRate(ctx);
      const value = await ctx.repos.environments.getSecret(ctx.db, env.id, input.key);
      ctx.log.info(
        {
          audit: 'secret.reveal',
          userId: ctx.user.id,
          environmentId: env.id,
          key: input.key,
          found: value !== undefined,
        },
        'secret revealed',
      );
      if (value === undefined) {
        throw new S1PilotError('NOT_FOUND', `Secret not found: ${input.key}`, { key: input.key });
      }
      return { key: input.key, value };
    }),

  /** Deletes an environment. A project must keep at least one; the default moves to another environment. */
  delete: publicProcedure.input(z.object({ id: IdSchema })).mutation(async ({ ctx, input }) => {
    const env = await requireEnvironment(ctx, input.id);
    const others = (await ctx.repos.environments.listByProject(ctx.db, env.projectId)).filter((e) => e.id !== env.id);
    if (others.length === 0) {
      throw new S1PilotError('INVALID_STATE', 'Cannot delete the only environment of a project');
    }
    const project = await ctx.repos.projects.get(ctx.db, env.projectId);
    if (project?.defaultEnvironmentId === env.id) {
      await ctx.repos.projects.update(ctx.db, env.projectId, { defaultEnvironmentId: others[0]?.id });
    }
    await ctx.repos.environments.delete(ctx.db, env.id);
    return { deleted: true as const, id: env.id };
  }),
});
