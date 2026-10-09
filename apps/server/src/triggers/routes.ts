import { S1PilotError } from '@s1pilot/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { createContext, type ServerDeps } from '../trpc/context.js';

import { tokenMatches } from './config.js';
import { firePlan } from './fire.js';

const WebhookBodySchema = z
  .object({
    buildRef: z.string().min(1).optional(),
    environment: z.string().min(1).optional(),
    commit: z.string().min(1).optional(),
  })
  .strict();

/**
 * Inbound "deployment finished" webhook: `POST /api/hooks/plans/:planId/:token` with an optional JSON body
 * `{ buildRef, environment, commit }`. Unknown plan or wrong token → 404; success → 202 `{ runId }`.
 */
export function registerWebhookRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post<{ Params: { planId: string; token: string } }>('/api/hooks/plans/:planId/:token', async (req, reply) => {
    const { planId, token } = req.params;
    const ctx = createContext(deps);
    const plan = await ctx.repos.plans.get(ctx.db, planId);
    if (!plan || !(await tokenMatches(ctx.db, planId, token))) return reply.code(404).send({ error: 'Not found' });
    const body = WebhookBodySchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Invalid body', issues: body.error.issues });
    const { buildRef, commit, environment } = body.data;
    const ref = buildRef ?? commit;
    try {
      const run = await firePlan(ctx, planId, 'webhook', {
        ...(ref !== undefined ? { buildRef: ref } : {}),
        ...(environment !== undefined ? { environment } : {}),
      });
      return reply.code(202).send({ runId: run.id });
    } catch (error) {
      if (error instanceof S1PilotError && (error.code === 'INVALID_STATE' || error.code === 'ENVIRONMENT_NOT_FOUND')) {
        return reply.code(422).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });
}
