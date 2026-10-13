import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { createVault, isPostgresUrl, openDb, type Db } from '@s1pilot/db';
import { S1PilotError } from '@s1pilot/domain/errors';
import { createLogger } from '@s1pilot/domain/logger';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { createArtifactStore } from './artifacts/factory.js';
import { startRetentionJob } from './artifacts/retention.js';
import { registerArtifactRoutes } from './artifacts/routes.js';
import { authDeps, registerSessionAuth } from './auth/http.js';
import { registerOidcRoutes } from './auth/oidc-routes.js';
import { registerTokenAuth } from './auth/tokens.js';
import type { ServerConfig } from './config.js';
import { registerExportRoutes } from './exports/routes.js';
import { registerLiveRoutes } from './live/routes.js';
import { registerManualRoutes } from './manual/routes.js';
import { ensureWorkerToken } from './remote/bootstrap.js';
import { registerRemoteWorkerRoutes } from './remote/routes.js';
import { registerTrackerWebhookRoutes } from './trackers/routes.js';
import { startTrackerSync } from './trackers/service.js';
import { firePlan } from './triggers/fire.js';
import { registerWebhookRoutes } from './triggers/routes.js';
import { SYSTEM_USER, createContext } from './trpc/context.js';
import { appRouter } from './trpc/router.js';
import { getVersion } from './version.js';
import { createRuntime, type RuntimeOptions } from './worker/runtime.js';

export interface BuildAppOptions {
  /** Use an already-open database (tests). Otherwise one is opened from `config.dbUrl`. */
  db?: Db;
  /** Directory of the built web app. Default: `apps/web/dist`. */
  webDist?: string;
  /** Enables dev-only behaviour (CORS). Default: `NODE_ENV !== 'production'`. */
  dev?: boolean;
  /** Worker pool overrides (model factory, browser launcher, timings); tests inject mocks here. */
  workerOptions?: RuntimeOptions['workerOptions'];
  /** Takeover browser launcher (tests inject a headless one). */
  launchHeaded?: RuntimeOptions['launchHeaded'];
  /** Remote worker tuning (tests shorten the lease). */
  remote?: RuntimeOptions['remote'];
  /** Number of in-process workers. Default `config.workers`. */
  workers?: number;
  /** Start the cron scheduler of plan schedules. Default true. */
  scheduler?: boolean;
  /** Poll issue trackers for status changes every 10 minutes (S-064). Default true. */
  trackerSync?: boolean;
}

/**
 * Builds the Fastify app: logger with redaction, CORS (dev only), websocket, static web app (production),
 * tRPC at `/trpc` and `GET /api/health`. Creates the data dir and database (running migrations) when missing.
 */
export async function buildApp(config: ServerConfig, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const dev = opts.dev ?? process.env['NODE_ENV'] !== 'production';
  const log = createLogger({ name: 's1pilot-server', level: config.logLevel }) as FastifyBaseLogger;

  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.artifactsDir, { recursive: true });
  if (opts.db === undefined && isPostgresUrl(config.dbUrl)) {
    throw new S1PilotError(
      'CONFIG_ERROR',
      'The repositories still run on SQLite; a postgres:// dbUrl is not supported yet. Use queueUrl (S1PILOT_QUEUE_URL) for the pg-boss queue and `s1pilot admin migrate-sqlite-to-pg` to copy data.',
    );
  }
  const ownsDb = opts.db === undefined;
  const db =
    opts.db ??
    openDb({ url: config.dbUrl, crypto: await createVault({ keyFile: join(config.dataDir, 'master.key') }) });

  // tRPC batches GETs as `/trpc/a.b,c.d,...`; Fastify's default 100-char `:path` param limit 404s busy pages.
  const app: FastifyInstance = Fastify({ loggerInstance: log, routerOptions: { maxParamLength: 5000 } });

  if (dev) await app.register(cors, { origin: true });
  await app.register(websocket);

  registerTokenAuth(app, db);
  registerSessionAuth(app, db, config);

  app.get('/api/health', async () => ({ ok: true, version: getVersion(), mode: config.mode }));

  const runtime = createRuntime({ db, config, log, ...(opts.launchHeaded ? { launchHeaded: opts.launchHeaded } : {}), ...(opts.workerOptions ? { workerOptions: opts.workerOptions } : {}), ...(opts.remote ? { remote: opts.remote } : {}) });
  runtime.remote.start();
  if (config.workerToken) await ensureWorkerToken(db, config.workerToken);
  registerRemoteWorkerRoutes(app, { db, service: runtime.remote });
  runtime.workers.start(opts.workers ?? config.workers);
  const artifacts = createArtifactStore(db, config);
  registerArtifactRoutes(app, artifacts, { presign: config.s3Presign !== false });
  registerExportRoutes(app, { db, runtime, config });
  const deps = { db, config, log, runtime };
  // Server-internal work (scheduler, inbound webhooks, tracker sync) runs as the system user in team mode.
  const sysDeps = config.mode === 'team' ? { ...deps, user: SYSTEM_USER } : deps;
  registerOidcRoutes(app, deps);
  registerWebhookRoutes(app, sysDeps);
  registerManualRoutes(app, deps);
  registerTrackerWebhookRoutes(app, sysDeps);
  if (opts.scheduler ?? true) await runtime.scheduler.start((planId) => firePlan(createContext(sysDeps), planId, 'schedule'));
  const stopRetention = startRetentionJob({ db, store: artifacts, log });
  const stopTrackerSync = opts.trackerSync === false ? () => undefined : startTrackerSync(() => createContext(sysDeps));
  app.addHook('onClose', async () => {
    stopRetention();
    stopTrackerSync();
    runtime.scheduler.stop();
    runtime.remote.stop();
    await runtime.auth.close();
    await runtime.recorder.close();
    await runtime.workers.stop(); // before the db closes
    await runtime.queue.close?.();
    if (ownsDb) db.close();
  });

  registerLiveRoutes(app, runtime.live, runtime.human, config);

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: ({ req, res }: { req: FastifyRequest; res: FastifyReply }) =>
        createContext({ db, config, log, runtime, ...(req.apiToken ? { token: req.apiToken } : {}), ...authDeps(req, res, config) }),
    },
  });

  const webDist = opts.webDist ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  if (!dev && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/trpc')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
