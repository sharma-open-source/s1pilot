import {
  DataPolicySchema,
  IdSchema,
  ProjectKeySchema,
  S1PilotError,
  newId,
  type Project,
  type RunSummary,
} from '@s1pilot/domain';
import { z } from 'zod';

import { deleteModelKey } from '../../worker/model-secrets.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { effectiveModelSettings, requireProject } from './helpers.js';
import { workspaceRetentionDays } from './workspace.js';

export type ProjectStatus = 'none' | 'running' | 'passing' | 'failing';

/** Project plus the aggregates shown on the dashboard and project list. */
async function withCounts(ctx: Context, project: Project) {
  const { db, repos } = ctx;
  const [cases, envs, runs, model] = await Promise.all([
    repos.cases.list(db, { projectId: project.id }),
    repos.environments.listByProject(db, project.id),
    repos.runs.listByProject(db, project.id, 1),
    effectiveModelSettings(ctx, project),
  ]);
  const last = runs[0];
  let status: ProjectStatus = 'none';
  if (last) {
    const s: RunSummary = last.summary;
    if (last.status === 'running' || last.status === 'queued' || last.status === 'paused') status = 'running';
    else status = s.failed > 0 || s.blocked > 0 ? 'failing' : 'passing';
  }
  return {
    ...project,
    counts: { cases: cases.length, environments: envs.length },
    lastRun: last
      ? {
          id: last.id,
          status: last.status,
          startedAt: last.startedAt,
          finishedAt: last.finishedAt,
          summary: last.summary,
        }
      : null,
    s1Model: model?.system1.model ?? null,
    status,
  };
}

const KeyInput = z.object({ key: ProjectKeySchema });

/** Projects CRUD. Project keys are immutable. */
export const projectsRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    const all = await ctx.repos.projects.list(ctx.db);
    return Promise.all(all.map((p) => withCounts(ctx, p)));
  }),

  /** Accepts the key as a plain string or `{ key }`. */
  get: publicProcedure.input(z.union([ProjectKeySchema, KeyInput])).query(async ({ ctx, input }) => {
    return withCounts(ctx, await requireProject(ctx, typeof input === 'string' ? input : input.key));
  }),

  /** Creates the project and its default `dev` environment. */
  create: publicProcedure
    .input(z.object({ name: z.string().trim().min(1), key: ProjectKeySchema, baseUrl: z.string().url() }))
    .mutation(async ({ ctx, input }) => {
      const { db, repos } = ctx;
      if (await repos.projects.getByKey(db, input.key)) {
        throw new S1PilotError('CONFLICT', `A project with key ${input.key} already exists`, { key: input.key });
      }
      const project = await repos.projects.create(db, { id: newId(), name: input.name, key: input.key });
      const env = await repos.environments.create(db, {
        id: newId(),
        projectId: project.id,
        name: 'dev',
        baseUrl: input.baseUrl,
      });
      await repos.projects.update(db, project.id, {
        defaultEnvironmentId: env.id,
        retentionDays: await workspaceRetentionDays(ctx),
      });
      return withCounts(ctx, await requireProject(ctx, input.key));
    }),

  /** Updates name, retention, heal policy, default environment and the data policy (merged field by field). */
  update: publicProcedure
    .input(
      z.object({
        key: ProjectKeySchema,
        name: z.string().trim().min(1).optional(),
        retentionDays: z.number().int().positive().optional(),
        autoApplyHeals: z.boolean().optional(),
        defaultEnvironmentId: IdSchema.optional(),
        dataPolicy: DataPolicySchema.partial().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.key);
      const { name, retentionDays, autoApplyHeals, dataPolicy, defaultEnvironmentId } = input;
      const rest = Object.fromEntries(
        Object.entries({ name, retentionDays, autoApplyHeals }).filter(([, v]) => v !== undefined),
      );
      if (defaultEnvironmentId !== undefined) {
        const env = await ctx.repos.environments.get(ctx.db, defaultEnvironmentId);
        if (env?.projectId !== project.id) {
          throw new S1PilotError('ENVIRONMENT_NOT_FOUND', `Environment not found in ${project.key}`, {
            id: defaultEnvironmentId,
          });
        }
      }
      await ctx.repos.projects.update(ctx.db, project.id, {
        ...rest,
        ...(defaultEnvironmentId !== undefined ? { defaultEnvironmentId } : {}),
        ...(dataPolicy ? { dataPolicy: DataPolicySchema.parse({ ...project.dataPolicy, ...dataPolicy }) } : {}),
      });
      return withCounts(ctx, await requireProject(ctx, input.key));
    }),

  /** Deletes the project and everything under it. */
  delete: publicProcedure.input(KeyInput).mutation(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.key);
    await ctx.repos.projects.delete(ctx.db, project.id);
    await Promise.all([deleteModelKey(ctx.db, project.id, 's1'), deleteModelKey(ctx.db, project.id, 's2')]);
    return { deleted: true as const, key: input.key };
  }),
});
