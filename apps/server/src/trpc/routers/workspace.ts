import { ProjectKeySchema } from '@s1pilot/domain';
import { z } from 'zod';

import { createArtifactStore } from '../../artifacts/factory.js';
import { isValidTimezone, workspaceTimezone } from '../../triggers/config.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireProject } from './helpers.js';
import { requireSession } from './tokens.js';

const NAME_KEY = 'workspace.name';
const TIMEZONE_KEY = 'workspace.timezone';
const RETENTION_KEY = 'workspace.retentionDays';
const DEFAULT_RETENTION_DAYS = 30;

/** Default retention applied to new projects. */
export async function workspaceRetentionDays(ctx: Pick<Context, 'db' | 'repos'>): Promise<number> {
  const v = await ctx.repos.settings.get(ctx.db, RETENTION_KEY);
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULT_RETENTION_DAYS;
}

async function general(ctx: Context) {
  const name = await ctx.repos.settings.get(ctx.db, NAME_KEY);
  return {
    name: typeof name === 'string' && name !== '' ? name : 'My workspace',
    timezone: await workspaceTimezone(ctx.db),
    retentionDays: await workspaceRetentionDays(ctx),
    mode: ctx.config.mode,
  };
}

/** Workspace settings (S-059): general, data retention, purge and workers. */
export const workspaceRouter = router({
  /** Workspace name, default timezone and default retention days. */
  get: publicProcedure.query(({ ctx }) => general(ctx)),

  update: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        timezone: z.string().refine(isValidTimezone, 'Unknown timezone').optional(),
        retentionDays: z.number().int().min(1).max(3650).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireSession(ctx);
      const { repos, db } = ctx;
      if (input.name !== undefined) await repos.settings.set(db, NAME_KEY, input.name);
      if (input.timezone !== undefined) await repos.settings.set(db, TIMEZONE_KEY, input.timezone);
      if (input.retentionDays !== undefined) await repos.settings.set(db, RETENTION_KEY, input.retentionDays);
      return general(ctx);
    }),

  /** Projects with their retention and stored artifact counts (Data & retention). */
  data: publicProcedure.query(async ({ ctx }) => {
    const projects = await ctx.repos.projects.list(ctx.db);
    return Promise.all(
      projects.map(async (p) => ({
        key: p.key,
        name: p.name,
        retentionDays: p.retentionDays,
        artifacts: (await ctx.repos.artifacts.listOlderThan(ctx.db, p.id, '9999-12-31T00:00:00.000Z')).length,
      })),
    );
  }),

  /** Deletes all stored artifacts (screenshots, traces, logs) of a project now, regardless of age. */
  purge: publicProcedure.input(z.object({ projectKey: ProjectKeySchema })).mutation(async ({ ctx, input }) => {
    requireSession(ctx);
    const project = await requireProject(ctx, input.projectKey);
    const store = createArtifactStore(ctx.db, ctx.config);
    const removed = await store.purge(new Date(Date.now() + 60_000), project.id);
    ctx.log.info({ project: project.key, removed, by: ctx.user.id }, 'manual artifact purge');
    return { removed };
  }),

  /** In-process workers with status and current job. */
  workers: publicProcedure.query(({ ctx }) => ({
    configured: ctx.config.workers,
    workers: ctx.runtime.workers.snapshot(),
    /** Workers on other machines that registered with this server (S-068). */
    remote: ctx.runtime.remote.registry.list(),
  })),
});
