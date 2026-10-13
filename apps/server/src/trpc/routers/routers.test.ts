import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createVault, openDb, type Db } from '@s1pilot/db';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import { loadModelSecrets, readModelKey } from '../../worker/model-secrets.js';
import { createContext, type ServerUser } from '../context.js';
import { appRouter, createCallerFactory } from '../router.js';


import { REVEAL_LIMIT } from './environments.js';

const makeCaller = createCallerFactory(appRouter);
const dbs: Db[] = [];
let servers: Server[] = [];

async function setup(user?: ServerUser) {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const ctx = createContext({ db, config: loadConfig({ dataDir: '/tmp/x' }, {}), log: createLogger({ level: 'silent' }) });
  return { api: makeCaller(user ? { ...ctx, user } : ctx), db };
}

function closeServers() {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  servers = [];
}

afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
  closeServers();
});

const mockSettings = (model = 'mock-1') => ({
  system1: { adapter: 'mock' as const, model },
  thresholds: { act: 0.8, pass: 0.8, fail: 0.2, escalate: 0.5 },
  dualOrderSensitive: false,
});

describe('projects', () => {
  it('creates SHOP with a dev env and lists it with zero counts', async () => {
    const { api } = await setup();
    const created = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://127.0.0.1:4400/shop' });
    expect(created.counts).toEqual({ cases: 0, environments: 1 });
    const list = await api.projects.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      key: 'SHOP',
      counts: { cases: 0, environments: 1 },
      lastRun: null,
      status: 'none',
      s1Model: null,
    });
    const envs = await api.environments.list({ projectKey: 'SHOP' });
    expect(envs.map((e) => e.name)).toEqual(['dev']);
    expect(list[0]?.defaultEnvironmentId).toBe(envs[0]?.id);
  });

  it('validates input and rejects duplicates / unknown keys', async () => {
    const { api } = await setup();
    await expect(api.projects.create({ name: 'x', key: 'bad key', baseUrl: 'http://a.test' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(api.projects.create({ name: 'x', key: 'OK', baseUrl: 'nope' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
    await expect(api.projects.create({ name: 'Again', key: 'SHOP', baseUrl: 'http://a.test' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(api.projects.get('NOPE')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('gets, updates (merging dataPolicy) and deletes', async () => {
    const { api } = await setup();
    await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
    expect(await api.projects.get({ key: 'SHOP' })).toMatchObject({ name: 'Shop' });
    const updated = await api.projects.update({
      key: 'SHOP',
      name: 'Shop 2',
      retentionDays: 7,
      dataPolicy: { sendScreenshots: 'never' },
    });
    expect(updated).toMatchObject({
      name: 'Shop 2',
      retentionDays: 7,
      dataPolicy: { sendScreenshots: 'never', sendPageText: true },
    });
    await expect(api.projects.update({ key: 'SHOP', retentionDays: -1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.projects.update({ key: 'SHOP', defaultEnvironmentId: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await api.projects.delete({ key: 'SHOP' });
    expect(await api.projects.list()).toEqual([]);
    await expect(api.projects.delete({ key: 'SHOP' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('environments', () => {
  async function withEnv() {
    const { api, db } = await setup();
    await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
    const env = await api.environments.create({
      projectKey: 'SHOP',
      name: 'staging',
      baseUrl: 'https://staging.test',
      variables: [
        { key: 'USER', value: 'alice', secret: false },
        { key: 'PASSWORD', value: 'hunter2-plaintext', secret: true },
      ],
    });
    return { api, db, env };
  }

  it('stores secrets encrypted and never returns them from get/list/create/update', async () => {
    const { api, db, env } = await withEnv();
    expect(env.variables).toContainEqual(expect.objectContaining({ key: 'PASSWORD', masked: true }));
    const outputs = [
      JSON.stringify(env),
      JSON.stringify(await api.environments.get({ id: env.id })),
      JSON.stringify(await api.environments.list({ projectKey: 'SHOP' })),
      JSON.stringify(await api.environments.update({ id: env.id, patch: { locale: 'de-DE' } })),
    ];
    for (const out of outputs) expect(out).not.toContain('hunter2');
    const raw = db.sqlite
      .prepare('SELECT value, secret_ciphertext AS c FROM variables WHERE key = ?')
      .get('PASSWORD') as { value: string | null; c: string };
    expect(raw.value).toBeNull();
    expect(raw.c).not.toContain('hunter2');
  });

  it('rejects plain variables named like passwords or tokens', async () => {
    const { api, env } = await withEnv();
    await expect(
      api.environments.update({ id: env.id, patch: { variables: [{ key: 'admin_pwd', value: 'x', secret: false }] } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('"admin_pwd" looks like a password or token') });
    await expect(
      api.environments.create({ projectKey: 'SHOP', name: 'qa', baseUrl: 'https://qa.test', variables: [{ key: 'API_TOKEN', value: 'x', secret: false }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await api.environments.update({ id: env.id, patch: { variables: [{ key: 'admin_pwd', value: 'x', secret: true }] } });
  });

  it('keeps an existing secret when update sends the variable without a value', async () => {
    const { api, env } = await withEnv();
    await api.environments.update({
      id: env.id,
      patch: {
        variables: [
          { key: 'PASSWORD', secret: true },
          { key: 'USER', value: 'bob', secret: false },
        ],
      },
    });
    expect((await api.environments.revealSecret({ envId: env.id, key: 'PASSWORD' })).value).toBe('hunter2-plaintext');
    expect((await api.environments.get({ id: env.id })).variables.find((v) => v.key === 'USER')).toMatchObject({
      value: 'bob',
    });
  });

  it('revealSecret returns plaintext, is rate-limited and role-checked', async () => {
    const { api, env } = await withEnv();
    expect(await api.environments.revealSecret({ envId: env.id, key: 'PASSWORD' })).toEqual({
      key: 'PASSWORD',
      value: 'hunter2-plaintext',
    });
    await expect(api.environments.revealSecret({ envId: env.id, key: 'USER' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(api.environments.revealSecret({ envId: 'nope', key: 'X' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    let limited: unknown;
    for (let i = 0; i < REVEAL_LIMIT + 1; i++) {
      limited = await api.environments.revealSecret({ envId: env.id, key: 'PASSWORD' }).catch((e: unknown) => e);
    }
    expect(limited).toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    const { api: viewer } = await setup({ id: 'v', role: 'viewer' });
    await expect(viewer.environments.revealSecret({ envId: 'x', key: 'k' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('validates input, rejects duplicate names and protects the last environment', async () => {
    const { api, env } = await withEnv();
    await expect(
      api.environments.create({ projectKey: 'SHOP', name: 'x', baseUrl: 'not-a-url' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      api.environments.create({ projectKey: 'SHOP', name: 'staging', baseUrl: 'http://a.test' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      api.environments.create({ projectKey: 'NOPE', name: 'x', baseUrl: 'http://a.test' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(api.environments.update({ id: 'missing', patch: {} })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await api.environments.delete({ id: env.id });
    const [dev] = await api.environments.list({ projectKey: 'SHOP' });
    await expect(api.environments.delete({ id: dev?.id ?? '' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });

  it('moves the project default when the default environment is deleted', async () => {
    const { api } = await withEnv();
    const dev = (await api.environments.list({ projectKey: 'SHOP' })).find((e) => e.name === 'dev');
    await api.environments.delete({ id: dev?.id ?? '' });
    const project = await api.projects.get('SHOP');
    expect(project.defaultEnvironmentId).toBeDefined();
    expect(project.defaultEnvironmentId).not.toBe(dev?.id);
  });
});

describe('models', () => {
  it('project settings fall back to the workspace defaults', async () => {
    const { api } = await setup();
    await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
    expect(await api.models.getSettings('SHOP')).toMatchObject({
      settings: null,
      effective: null,
      inheritsFromWorkspace: true,
    });

    await api.models.updateSettings({ target: 'workspace', settings: mockSettings('ws-model') });
    expect(await api.models.getSettings('workspace')).toMatchObject({
      scope: 'workspace',
      inheritsFromWorkspace: false,
    });
    const inherited = await api.models.getSettings('SHOP');
    expect(inherited).toMatchObject({ inheritsFromWorkspace: true, settings: null });
    expect(inherited.effective?.system1.model).toBe('ws-model');
    expect((await api.projects.get('SHOP')).s1Model).toBe('ws-model');

    const own = await api.models.updateSettings({ target: 'SHOP', settings: mockSettings('proj-model') });
    expect(own.inheritsFromWorkspace).toBe(false);
    expect(own.effective?.system1.model).toBe('proj-model');

    const cleared = await api.models.updateSettings({ target: 'SHOP', settings: null });
    expect(cleared.inheritsFromWorkspace).toBe(true);
    expect(cleared.effective?.system1.model).toBe('ws-model');
  });

  it('validates settings and unknown projects', async () => {
    const { api } = await setup();
    const bad = { ...mockSettings(), thresholds: { act: 0.5, pass: 0.5, fail: 0.9, escalate: 0.1 } };
    await expect(api.models.updateSettings({ target: 'workspace', settings: bad })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      api.models.updateSettings({
        target: 'workspace',
        settings: { ...mockSettings(), system1: { adapter: 'systemone', model: 'm' } },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.models.getSettings('NOPE')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  async function fakeSystemOne(): Promise<string> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.method !== 'POST' || req.url !== '/v1/systemone') {
          res.writeHead(404, { 'content-type': 'application/json' });
          return void res.end('{}');
        }
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
          questions: Record<string, { type: string }>;
        };
        const answers = Object.fromEntries(
          Object.entries(body.questions).map(([id, q]) => [
            id,
            q.type === 'choice' ? { probabilities: { e2: 0.8, e1: 0.1, e3: 0.1 } } : { noul: 0.7 },
          ]),
        );
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ answers }));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('probe detects the adapter and capabilities of a fake systemone server', async () => {
    const { api } = await setup();
    const baseUrl = await fakeSystemOne();
    const result = await api.models.probe({ baseUrl, model: 'fake-s1' });
    expect(result).toMatchObject({ ok: true, adapter: 'systemone', model: 'fake-s1', isCloud: false });
    expect(result.capabilities).toBeDefined();
    await expect(api.models.probe({ baseUrl: 'not a url' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('probe reports an unreachable endpoint as ok:false', async () => {
    const { api } = await setup();
    const result = await api.models.probe({ baseUrl: 'http://127.0.0.1:1', model: 'm', timeoutMs: 500 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('stores a pasted key encrypted, keeps, uses and removes it, and never returns it', async () => {
    const { api, db } = await setup();
    const KEY = 'sk-test-pasted-123';
    const seen: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      req.on('end', () => {
        if (req.headers.authorization !== `Bearer ${KEY}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          return void res.end('{"error":"unauthorized"}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ answers: { q: { probabilities: { e1: 1 } } } }));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const settings = { ...mockSettings(), system1: { adapter: 'systemone' as const, baseUrl, model: 'fake-s1' } };

    const saved = await api.models.updateSettings({ target: 'workspace', settings, apiKeys: { s1: KEY } });
    const ref = saved.settings?.system1.apiKeyRef;
    expect(ref).toBe('secret:model/workspace/s1');
    expect(JSON.stringify(saved)).not.toContain(KEY);
    expect(JSON.stringify(await api.models.getSettings('workspace'))).not.toContain(KEY);
    const dump = db.sqlite.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>;
    for (const { name } of dump) expect(JSON.stringify(db.sqlite.prepare(`select * from "${name}"`).all()), name).not.toContain(KEY);

    // Test connection with the saved key: only for the host it was saved for.
    await api.models.probe({ target: 'workspace', baseUrl, model: 'fake-s1', adapter: 'systemone', apiKeyRef: ref, timeoutMs: 2000 });
    expect(seen).toContain(`Bearer ${KEY}`);
    seen.length = 0;
    await api.models.probe({ target: 'workspace', baseUrl: `http://localhost:${port}`, model: 'fake-s1', adapter: 'systemone', apiKeyRef: ref, timeoutMs: 2000 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(`Bearer ${KEY}`);

    // Saving again with the ref keeps the key; a project cannot borrow it; null removes it.
    await api.models.updateSettings({ target: 'workspace', settings: { ...settings, system1: { ...settings.system1, apiKeyRef: ref } } });
    expect(await loadModelSecrets(db, (await api.models.getSettings('workspace')).settings)).toEqual({ s1: KEY });
    await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
    await expect(
      api.models.updateSettings({ target: 'SHOP', settings: { ...settings, system1: { ...settings.system1, apiKeyRef: ref } } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const removed = await api.models.updateSettings({ target: 'workspace', settings: { ...settings, system1: { ...settings.system1, apiKeyRef: ref } }, apiKeys: { s1: null } });
    expect(removed.settings?.system1.apiKeyRef).toBeUndefined();
    expect(await readModelKey(db, 'secret:model/workspace/s1')).toBeUndefined();
  });

  it('status reports reachability and caches for 30 s', async () => {
    const { api } = await setup();
    const baseUrl = await fakeSystemOne();
    expect(await api.models.status()).toEqual({
      system1: { configured: false, reachable: false },
      system2: { configured: false, reachable: false },
    });
    await api.models.updateSettings({
      target: 'workspace',
      settings: { ...mockSettings(), system1: { adapter: 'systemone', baseUrl, model: 'fake-s1' } },
    });
    const first = await api.models.status();
    expect(first.system1).toMatchObject({ configured: true, reachable: true, model: 'fake-s1' });
    closeServers();
    expect((await api.models.status()).system1.reachable).toBe(true); // served from cache
  });
});
