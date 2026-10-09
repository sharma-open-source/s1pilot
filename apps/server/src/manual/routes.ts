import { S1PilotError } from '@s1pilot/domain';
import type { FastifyInstance } from 'fastify';

import { createContext, type ServerDeps } from '../trpc/context.js';
import { MAX_ATTACHMENT_BYTES, attachToStep } from '../trpc/routers/manual.js';

/**
 * Registers `POST /api/manual/:itemId/attachments?step=<0-based>&name=<file name>`: the request body is the raw
 * image or video (Content-Type `image/*` or `video/*`). Stores it in the artifact store and attaches it to the step.
 * Responds `201 { id, url, kind }`.
 */
export function registerManualRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Scoped plugin so the binary body parsers do not affect other routes.
  void app.register(async (scope) => {
    scope.addContentTypeParser(/^(image|video)\//, { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT_BYTES }, (_req, body, done) => done(null, body));
    scope.post<{ Params: { itemId: string }; Querystring: { step?: string; name?: string } }>('/api/manual/:itemId/attachments', async (req, reply) => {
      const step = Number(req.query.step);
      if (!Number.isInteger(step) || step < 0) return reply.code(400).send({ error: 'Query parameter step must be a 0-based step index' });
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Send the file as an image/* or video/* body' });
      const contentType = (req.headers['content-type'] ?? '').split(';')[0] ?? '';
      try {
        const saved = await attachToStep(createContext(deps), req.params.itemId, step, {
          name: req.query.name?.slice(0, 120) || `attachment-${Date.now()}`,
          contentType,
          data: req.body,
        });
        return reply.code(201).send(saved);
      } catch (error) {
        if (error instanceof S1PilotError) {
          const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 400;
          return reply.code(status).send({ error: error.message, code: error.code });
        }
        throw error;
      }
    });
  });
}
