import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '@s1pilot/db';
import { S1PilotError } from '@s1pilot/domain/errors';
import { createLogger } from '@s1pilot/domain/logger';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppRouter } from './router.js';
import { createContext } from './trpc/context.js';
import { createCallerFactory, publicProcedure, router } from './trpc/router.js';

import { buildApp, getVersion, loadConfig } from './index.js';

const dirs: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 's1pilot-server-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('config', () => {
  it('applies defaults and derives paths from dataDir', () => {
    const c = loadConfig({ dataDir: '/tmp/x' }, {});
    expect(c).toMatchObject({
      port: 5317,
      mode: 'local',
      dataDir: '/tmp/x',
      dbUrl: 'file:/tmp/x/data.db',
      artifactsDir: '/tmp/x/artifacts',
    });
  });

  it('reads env and rejects invalid values', () => {
    expect(loadConfig({ dataDir: '/tmp/x' }, { S1PILOT_PORT: '8000', S1PILOT_MODE: 'team' })).toMatchObject({
      port: 8000,
      mode: 'team',
    });
    expect(() => loadConfig({ dataDir: '/tmp/x' }, { S1PILOT_MODE: 'cloud' })).toThrow(S1PilotError);
  });
});

describe('server', () => {
  it('starts with an empty data dir, creates the DB and serves /api/health', async () => {
    const dataDir = join(tmp(), 'fresh');
    const app = await buildApp(loadConfig({ dataDir, logLevel: 'silent' }, {}));
    apps.push(app);
    expect(existsSync(join(dataDir, 'data.db'))).toBe(true);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, version: getVersion(), mode: 'local' });
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('serves tRPC health to a typed client', async () => {
    const app = await buildApp(loadConfig({ dataDir: tmp(), logLevel: 'silent' }, {}));
    apps.push(app);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${address}/trpc` })] });
    expect(await client.health.query()).toEqual({ ok: true, version: getVersion(), mode: 'local' });
  });

  it('accepts batched tRPC GETs whose procedure list is longer than 100 characters', async () => {
    const app = await buildApp(loadConfig({ dataDir: tmp(), logLevel: 'silent' }, {}));
    apps.push(app);
    const paths = Array.from({ length: 20 }, () => 'health');
    const input = encodeURIComponent(JSON.stringify(Object.fromEntries(paths.map((_, i) => [i, {}]))));
    const res = await app.inject({ method: 'GET', url: `/trpc/${paths.join(',')}?batch=1&input=${input}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(20);
  });
});

describe('trpc context and error mapping', () => {
  const testRouter = router({
    missing: publicProcedure.query(() => {
      throw new S1PilotError('PROJECT_NOT_FOUND', 'no such project', { key: 'X' });
    }),
    bad: publicProcedure.query(() => {
      throw new S1PilotError('INVALID_CASE_KEY', 'bad key');
    }),
  });

  it('uses the local admin user and maps S1PilotError codes', async () => {
    const db = openDb({ url: ':memory:' });
    const ctx = createContext({
      db,
      config: loadConfig({ dataDir: '/tmp/x' }, {}),
      log: createLogger({ level: 'silent' }),
    });
    expect(ctx.user).toMatchObject({ id: 'local', role: 'admin' });
    const caller = createCallerFactory(testRouter)(ctx);
    await expect(caller.missing()).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'no such project' });
    await expect(caller.bad()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    db.close();
  });
});
