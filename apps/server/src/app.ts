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
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';

import { startRetentionJob } from './artifacts/retention.js';
import { registerArtifactRoutes } from './artifacts/routes.js';
import { FsArtifactStore } from './artifacts/store.js';
import { registerTokenAuth } from './auth/tokens.js';
import type { ServerConfig } from './config.js';
import { registerExportRoutes } from './exports/routes.js';
import { registerLiveRoutes } from './live/routes.js';
import { registerManualRoutes } from './manual/routes.js';
import { registerTrackerWebhookRoutes } from './trackers/routes.js';
import { startTrackerSync } from './trackers/service.js';
import { firePlan } from './triggers/fire.js';
import { registerWebhookRoutes } from './triggers/routes.js';
import { createContext } from './trpc/context.js';
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

  const app: FastifyInstance = Fastify({ loggerInstance: log });

  if (dev) await app.register(cors, { origin: true });
  await app.register(websocket);

  registerTokenAuth(app, db);

  app.get('/api/health', async () => ({ ok: true, version: getVersion(), mode: config.mode }));

  const runtime = createRuntime({ db, config, log, ...(opts.launchHeaded ? { launchHeaded: opts.launchHeaded } : {}), ...(opts.workerOptions ? { workerOptions: opts.workerOptions } : {}) });
  runtime.workers.start(opts.workers ?? config.workers);
  const artifacts = new FsArtifactStore(db, config.artifactsDir);
  registerArtifactRoutes(app, artifacts);
  registerExportRoutes(app, { db, runtime, config });
  const deps = { db, config, log, runtime };
  registerWebhookRoutes(app, deps);
  registerManualRoutes(app, deps);
  registerTrackerWebhookRoutes(app, deps);
  if (opts.scheduler ?? true) await runtime.scheduler.start((planId) => firePlan(createContext(deps), planId, 'schedule'));
  const stopRetention = startRetentionJob({ db, store: artifacts, log });
  const stopTrackerSync = opts.trackerSync === false ? () => undefined : startTrackerSync(() => createContext(deps));
  app.addHook('onClose', async () => {
    stopRetention();
    stopTrackerSync();
    runtime.scheduler.stop();
    await runtime.auth.close();
    await runtime.recorder.close();
    await runtime.workers.stop(); // before the db closes
    await runtime.queue.close?.();
    if (ownsDb) db.close();
  });

  registerLiveRoutes(app, runtime.live, runtime.human);

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }: { req: FastifyRequest }) => createContext({ db, config, log, runtime, ...(req.apiToken ? { token: req.apiToken } : {}) }),
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
