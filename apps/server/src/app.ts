import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { createVault, openDb, type Db } from '@s1pilot/db';
import { createLogger } from '@s1pilot/domain/logger';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import type { ServerConfig } from './config.js';
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
  /** Number of in-process workers. Default `config.workers`. */
  workers?: number;
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
  const ownsDb = opts.db === undefined;
  const db =
    opts.db ??
    openDb({ url: config.dbUrl, crypto: await createVault({ keyFile: join(config.dataDir, 'master.key') }) });

  const app: FastifyInstance = Fastify({ loggerInstance: log });

  if (dev) await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get('/api/health', async () => ({ ok: true, version: getVersion(), mode: config.mode }));

  const runtime = createRuntime({ db, config, log, ...(opts.workerOptions ? { workerOptions: opts.workerOptions } : {}) });
  runtime.workers.start(opts.workers ?? config.workers);
  app.addHook('onClose', async () => {
    await runtime.workers.stop(); // before the db closes
    if (ownsDb) db.close();
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: () => createContext({ db, config, log, runtime }),
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
