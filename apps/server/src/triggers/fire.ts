import { S1PilotError, type RunTrigger, type TestRun } from '@s1pilot/domain';

import type { Context } from '../trpc/context.js';
import { startPlanRun } from '../trpc/routers/runs.js';

/** Starts a run of a plan for a non-manual trigger (`schedule` or `webhook`). */
export async function firePlan(
  ctx: Context,
  planId: string,
  trigger: Extract<RunTrigger, 'schedule' | 'webhook'>,
  opts: { buildRef?: string; environment?: string } = {},
): Promise<TestRun> {
  const plan = await ctx.repos.plans.get(ctx.db, planId);
  if (!plan) throw new S1PilotError('PLAN_NOT_FOUND', `Plan not found: ${planId}`, { planId });
  const project = await ctx.repos.projects.get(ctx.db, plan.projectId);
  if (!project) throw new S1PilotError('PROJECT_NOT_FOUND', `Project not found: ${plan.projectId}`, { planId });
  return startPlanRun(ctx, project, plan, {
    trigger,
    ...(opts.buildRef !== undefined ? { buildRef: opts.buildRef } : {}),
    ...(opts.environment !== undefined ? { environment: opts.environment } : {}),
  });
}
