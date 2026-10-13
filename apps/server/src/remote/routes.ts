import type { Db } from '@s1pilot/db';
import { S1PilotError } from '@s1pilot/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { authenticateToken } from '../auth/tokens.js';

import {
  CaseDoneBodySchema,
  CaseResultBodySchema,
  FailJobSchema,
  HealProposalDraftSchema,
  HeartbeatSchema,
  ScriptGetSchema,
  ScriptPutSchema,
  type WorkerMessage,
} from './protocol.js';
import { RegisterWorkerSchema } from './registry.js';
import type { RemoteWorkerService } from './service.js';

/** Largest artifact a worker can upload (videos and traces). */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

const STATUS: Record<string, number> = { WORKER_UNKNOWN: 404, JOB_NOT_OWNED: 409, NOT_FOUND: 404, ARTIFACT_PATH: 400 };

const bearerOf = (req: FastifyRequest): string | undefined => /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1];

/**
 * Registers the remote worker API (S-068), all of it behind an API token with the `runs:write` scope (also in local
 * mode, where tRPC calls without a header count as the local session):
 *
 * - `POST /api/workers/register`, `POST /api/workers/:id/heartbeat`, `POST /api/workers/:id/claim` (204 when idle)
 * - `POST /api/workers/:id/jobs/:jobId/{complete,fail,case-result,case-done,scripts/get,scripts/put,heal-proposals}`
 * - `PUT  /api/workers/:id/jobs/:jobId/files?caseResultId=…&file=…` (raw bytes of an artifact)
 * - `GET  /ws/workers/:id` (WebSocket): worker events and binary screencast frames in; screencast demand and abort out.
 */
export function registerRemoteWorkerRoutes(app: FastifyInstance, deps: { db: Db; service: RemoteWorkerService }): void {
  const { db, service } = deps;
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));
    scope.setErrorHandler((error, req, reply) => {
      if (error instanceof S1PilotError) return reply.code(STATUS[error.code] ?? 400).send({ error: error.message, code: error.code });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: error.message, code: 'INVALID_REQUEST' });
      req.log.error({ err: error }, 'worker api error');
      return reply.code(500).send({ error: 'Internal error' });
    });
    scope.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/api/workers')) return;
      if (!req.apiToken?.scopes.includes('runs:write')) {
        return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Workers authenticate with an API token that has the runs:write scope' });
      }
    });

    const P = z.object({ id: z.string(), jobId: z.string() });

    scope.post('/api/workers/register', async (req) => service.register(RegisterWorkerSchema.parse(req.body ?? {})));

    scope.post<{ Params: { id: string } }>('/api/workers/:id/heartbeat', async (req) => service.heartbeat(req.params.id, HeartbeatSchema.parse(req.body ?? {}).jobs));

    scope.post<{ Params: { id: string } }>('/api/workers/:id/claim', async (req, reply) => {
      const claimed = await service.claim(req.params.id);
      return claimed ? claimed : reply.code(204).send();
    });

    scope.post('/api/workers/:id/jobs/:jobId/complete', async (req, reply) => {
      const p = P.parse(req.params);
      const ok = await service.complete(p.id, p.jobId);
      return ok ? { ok } : reply.code(409).send({ ok, error: 'The lease was lost' });
    });

    scope.post('/api/workers/:id/jobs/:jobId/fail', async (req, reply) => {
      const p = P.parse(req.params);
      const body = FailJobSchema.parse(req.body);
      const ok = await service.fail(p.id, p.jobId, body.error, body.retry);
      return ok ? { ok } : reply.code(409).send({ ok, error: 'The lease was lost' });
    });

    scope.post('/api/workers/:id/jobs/:jobId/case-result', async (req) => {
      const p = P.parse(req.params);
      const body = CaseResultBodySchema.parse(req.body);
      await service.recordCase(p.id, p.jobId, body.attempt, body.result);
      return { ok: true };
    });

    scope.put('/api/workers/:id/jobs/:jobId/files', { bodyLimit: MAX_UPLOAD_BYTES }, async (req) => {
      const p = P.parse(req.params);
      const q = z.object({ caseResultId: z.string(), file: z.string().min(1).max(300) }).parse(req.query);
      if (!Buffer.isBuffer(req.body)) throw new S1PilotError('INVALID_REQUEST', 'Send the file as application/octet-stream');
      await service.receiveFile(p.id, p.jobId, q.caseResultId, q.file, req.body);
      return { ok: true };
    });

    scope.post('/api/workers/:id/jobs/:jobId/case-done', async (req) => {
      const p = P.parse(req.params);
      const body = CaseDoneBodySchema.parse(req.body);
      return { ok: true, artifacts: await service.caseDone(p.id, p.jobId, body.caseResultId) };
    });

    scope.post('/api/workers/:id/jobs/:jobId/scripts/get', async (req) => {
      const p = P.parse(req.params);
      const body = ScriptGetSchema.parse(req.body);
      return { script: (await service.getScript(p.id, p.jobId, body.caseId, body.environmentId)) ?? null };
    });

    scope.post('/api/workers/:id/jobs/:jobId/scripts/put', async (req) => {
      const p = P.parse(req.params);
      await service.putScript(p.id, p.jobId, ScriptPutSchema.parse(req.body).script);
      return { ok: true };
    });

    scope.post('/api/workers/:id/jobs/:jobId/heal-proposals', async (req) => {
      const p = P.parse(req.params);
      await service.createHealProposal(p.id, p.jobId, HealProposalDraftSchema.parse(req.body));
      return { ok: true };
    });

    scope.get<{ Params: { id: string } }>('/ws/workers/:id', { websocket: true }, (socket, req) => {
      const workerId = req.params.id;
      const token = bearerOf(req);
      void (async () => {
        const principal = token ? await authenticateToken(db, token) : undefined;
        if (!principal?.scopes.includes('runs:write')) return socket.close(1008, 'unauthorized');
        if (!service.registry.has(workerId)) return socket.close(1008, 'worker not registered');
        const detach = service.attachSocket(workerId, { send: (m) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m)) });
        socket.on('close', detach);
        socket.send(JSON.stringify({ type: 'ready' }));
        socket.on('error', () => socket.close());
        socket.on('message', (data, isBinary) => {
          if (isBinary) return service.handleFrame(workerId, Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
          try {
            const msg = JSON.parse(String(data)) as WorkerMessage;
            if (msg.type === 'event') service.handleEvent(workerId, msg.jobId, msg.event);
          } catch {
            // ignore malformed message
          }
        });
      })().catch(() => socket.close());
    });
  });
}
