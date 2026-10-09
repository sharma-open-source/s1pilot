import type { FastifyInstance } from 'fastify';

import { createContext, type ServerDeps } from '../trpc/context.js';

import { TrackerProviderSchema, handleWebhook, webhookMatches } from './service.js';

/**
 * Inbound tracker webhooks: `POST /api/hooks/trackers/:provider/:token` (Jira, GitHub). The token is the secret
 * created by `trackers.rotateWebhook`; unknown provider / wrong token -> 404. Success -> 202 `{ matched }`.
 */
export function registerTrackerWebhookRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post<{ Params: { provider: string; token: string } }>('/api/hooks/trackers/:provider/:token', async (req, reply) => {
    const provider = TrackerProviderSchema.safeParse(req.params.provider);
    const ctx = createContext(deps);
    if (!provider.success || provider.data === 'linear' || !(await webhookMatches(ctx, provider.data, req.params.token))) {
      return reply.code(404).send({ error: 'Not found' });
    }
    try {
      return reply.code(202).send({ matched: await handleWebhook(ctx, provider.data, req.body) });
    } catch (error) {
      ctx.log.warn({ err: error instanceof Error ? error.message : 'unknown' }, 'tracker webhook failed');
      return reply.code(502).send({ error: 'Could not process the webhook' });
    }
  });
}
