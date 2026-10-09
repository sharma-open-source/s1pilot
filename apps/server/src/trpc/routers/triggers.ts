import { IdSchema, ProjectKeySchema, S1PilotError } from '@s1pilot/domain';
import { z } from 'zod';

import {
  getTriggerConfig,
  isValidTimezone,
  regenerateToken,
  updateTriggerConfig,
  workspaceTimezone,
} from '../../triggers/config.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireProject } from './helpers.js';
import { requirePlan } from './plans.js';

async function view(ctx: Context, planId: string) {
  const c = await getTriggerConfig(ctx.db, planId);
  return {
    planId,
    token: c.token,
    /** Path to POST to, relative to the server origin. */
    webhookPath: `/api/hooks/plans/${planId}/${c.token}`,
    timezone: c.timezone ?? null,
    effectiveTimezone: c.timezone ?? (await workspaceTimezone(ctx.db)),
    skipIfRunning: c.skipIfRunning,
  };
}

function requireWriter(ctx: Context): void {
  if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot change triggers');
}

/** Plan triggers: webhook token, schedule timezone / overlap policy, upcoming scheduled runs (S-052). */
export const triggersRouter = router({
  /** Webhook URL path, token, timezone and overlap policy of a plan (creates the token on first read). */
  get: publicProcedure.input(IdSchema).query(async ({ ctx, input }) => {
    await requirePlan(ctx, input);
    return view(ctx, input);
  }),

  /** Sets the plan's schedule timezone (`null` = workspace default) and/or overlap policy. */
  update: publicProcedure
    .input(z.object({ planId: IdSchema, timezone: z.string().nullable().optional(), skipIfRunning: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      requireWriter(ctx);
      await requirePlan(ctx, input.planId);
      if (typeof input.timezone === 'string' && !isValidTimezone(input.timezone)) {
        throw new S1PilotError('INVALID_INPUT', `Unknown timezone: ${input.timezone}`, { timezone: input.timezone });
      }
      await updateTriggerConfig(ctx.db, input.planId, {
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
        ...(input.skipIfRunning !== undefined ? { skipIfRunning: input.skipIfRunning } : {}),
      });
      await ctx.runtime.scheduler.reload(input.planId);
      return view(ctx, input.planId);
    }),

  /** Issues a new webhook token; the previous URL stops working. */
  regenerateToken: publicProcedure.input(IdSchema).mutation(async ({ ctx, input }) => {
    requireWriter(ctx);
    await requirePlan(ctx, input);
    await regenerateToken(ctx.db, input);
    return view(ctx, input);
  }),

  /** The next 10 scheduled runs across the project's plans, soonest first. */
  upcoming: publicProcedure.input(ProjectKeySchema).query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input);
    const plans = await ctx.repos.plans.listByProject(ctx.db, project.id);
    return ctx.runtime.scheduler.upcoming(plans, 10);
  }),
});
