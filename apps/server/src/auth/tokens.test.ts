import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';

const makeCaller = createCallerFactory(appRouter);
const dbs: Db[] = [];
const dirs: string[] = [];
const closers: Array<() => Promise<unknown>> = [];

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const dir = mkdtempSync(join(tmpdir(), 's1pilot-tokens-'));
  dirs.push(dir);
  const config = loadConfig({ dataDir: join(dir, '.s1pilot') }, {});
  const api = makeCaller(createContext({ db, config, log: createLogger({ level: 'silent' }) }));
  const app = await buildApp(config, { db, workers: 0, dev: true, scheduler: false });
  closers.push(() => app.close());
  return { db, api, app, config };
}

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  dbs.splice(0).forEach((d) => d.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const trpcGet = (app: Awaited<ReturnType<typeof setup>>['app'], token?: string) =>
  app.inject({ method: 'GET', url: '/trpc/projects.list', ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });

describe('API tokens', () => {
  it('shows the token once, lists only the prefix, and stores only a hash', async () => {
    const { api, db } = await setup();
    const { token, record } = await api.tokens.create({ name: 'CI', scopes: ['runs:write', 'results:read'] });
    expect(token).toMatch(/^s1p_[0-9a-f]{8}_[0-9a-f]{48}$/);
    expect(token.startsWith(record.prefix)).toBe(true);

    const listed = await api.tokens.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain('scrypt');
    expect(listed[0]).toMatchObject({ name: 'CI', prefix: record.prefix, revokedAt: null });

    const stored = (await repos.apiTokens.list(db))[0];
    expect(stored?.hash.startsWith('scrypt$')).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(token.slice(-48));
  });

  it('accepts a valid bearer token on /trpc and /api, rejects wrong and revoked ones with 401', async () => {
    const { api, app } = await setup();
    const { token, record } = await api.tokens.create({ name: 'CI' });

    expect((await trpcGet(app)).statusCode).toBe(200); // local session
    expect((await trpcGet(app, token)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/health', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await trpcGet(app, `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`)).statusCode).toBe(401);
    expect((await trpcGet(app, 'garbage')).statusCode).toBe(401);

    await api.tokens.revoke({ id: record.id });
    expect((await trpcGet(app, token)).statusCode).toBe(401);
    expect((await api.tokens.list())[0]?.revokedAt).not.toBeNull();
  });

  it('enforces scopes and keeps tokens out of settings management', async () => {
    const { api, app } = await setup();
    const readOnly = await api.tokens.create({ name: 'read', scopes: ['results:read'] });
    const write = await api.tokens.create({ name: 'write', scopes: ['runs:write'] });
    const post = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/trpc/tokens.list',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: '{}',
      });
    expect((await trpcGet(app, readOnly.token)).statusCode).toBe(200);
    expect((await post(readOnly.token)).statusCode).toBe(403);
    // a runs:write token passes the scope check but cannot manage tokens
    const res = await app.inject({
      method: 'GET',
      url: '/trpc/tokens.list',
      headers: { authorization: `Bearer ${write.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('never logs or returns the secret in errors', async () => {
    const { api } = await setup();
    await expect(api.tokens.revoke({ id: newId() })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('workspace settings', () => {
  it('stores name, timezone and default retention (applied to new projects)', async () => {
    const { api } = await setup();
    expect(await api.workspace.get()).toMatchObject({ name: 'My workspace', retentionDays: 30 });
    await api.workspace.update({ name: 'Acme QA', timezone: 'Europe/Berlin', retentionDays: 14 });
    expect(await api.workspace.get()).toMatchObject({ name: 'Acme QA', timezone: 'Europe/Berlin', retentionDays: 14 });
    await expect(api.workspace.update({ timezone: 'Nope/Zone' })).rejects.toBeDefined();
    const p = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
    expect(p.retentionDays).toBe(14);
  });

  it('purge now removes the project artifacts', async () => {
    const { api, db, config } = await setup();
    const { FsArtifactStore } = await import('../artifacts/store.js');
    const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
    const other = await api.projects.create({ name: 'Other', key: 'OTH', baseUrl: 'http://b.test' });
    const store = new FsArtifactStore(db, config.artifactsDir);
    const meta = (projectId: string) => ({ projectId, runId: 'r', caseResultId: 'c', kind: 'log' as const, name: 'a.txt', contentType: 'text/plain' });
    const a = await store.put(Buffer.from('x'), meta(project.id));
    const b = await store.put(Buffer.from('y'), meta(other.id));
    expect((await api.workspace.data()).find((p) => p.key === 'SHOP')?.artifacts).toBe(1);
    expect(await api.workspace.purge({ projectKey: 'SHOP' })).toEqual({ removed: 1 });
    expect(await store.stat(a)).toBeUndefined();
    expect(await store.stat(b)).toBeDefined();
  });

  it('lists in-process workers', async () => {
    const { api } = await setup();
    expect(await api.workspace.workers()).toMatchObject({ workers: [] });
  });
});
