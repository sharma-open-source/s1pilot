import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVault, identityCrypto, openDb, repos, type Db } from '@s1pilot/db';
import { TestCaseFileSchema, newId, type DecisionModel } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, loadMockScript, mockResolver } from '@s1pilot/providers';
import { loadCaseFile } from '@s1pilot/sync';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';
import { runtimeFor } from '../worker/runtime.js';

import { runRetention } from './retention.js';
import { parseRange } from './routes.js';
import { FsArtifactStore } from './store.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const casesDir = fileURLToPath(new URL('../../../../fixtures/sites/cases/shop/', import.meta.url));
const dirs: string[] = [];
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 's1p-art-'));
  dirs.push(d);
  return d;
};

async function drain(stream: AsyncIterable<Buffer | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('FsArtifactStore', () => {
  async function storeSetup() {
    const db = openDb({ url: ':memory:', crypto: identityCrypto });
    cleanups.push(() => db.close());
    const project = await repos.projects.create(db, { id: newId(), name: 'Shop', key: 'SHOP' });
    const root = join(tmp(), 'artifacts');
    return { db, project, root, store: new FsArtifactStore(db, root) };
  }
  const meta = (projectId: string, name = 'a.txt') => ({
    projectId,
    runId: 'run1',
    caseResultId: 'cr1',
    kind: 'log' as const,
    name,
    contentType: 'text/plain',
  });

  it('puts buffers, streams the content back (with ranges), and deletes', async () => {
    const { store, project, root } = await storeSetup();
    const id = await store.put(Buffer.from('0123456789'), meta(project.id));
    const rec = await store.stat(id);
    expect(rec).toMatchObject({ size: 10, contentType: 'text/plain', name: 'a.txt' });
    expect(existsSync(join(root, rec?.path ?? ''))).toBe(true);
    expect(rec?.path.startsWith(join(project.id, 'run1', 'cr1'))).toBe(true);
    expect((await drain(await store.get(id))).toString()).toBe('0123456789');
    expect((await drain(await store.get(id, { start: 2, end: 4 }))).toString()).toBe('234');
    await store.delete(id);
    expect(await store.stat(id)).toBeUndefined();
    expect(existsSync(join(root, rec?.path ?? ''))).toBe(false);
    await expect(store.get(id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('purge removes files and rows older than the cutoff, for one project only', async () => {
    const { db, store, project, root } = await storeSetup();
    const other = await repos.projects.create(db, { id: newId(), name: 'Other', key: 'OTH' });
    const oldId = await store.put(Buffer.from('old'), meta(project.id, 'old.txt'));
    const otherId = await store.put(Buffer.from('other'), meta(other.id, 'other.txt'));
    const oldRec = await store.stat(oldId);
    db.sqlite.prepare('UPDATE artifacts SET created_at = ? WHERE id IN (?, ?)').run('2020-01-01T00:00:00.000Z', oldId, otherId);
    const freshId = await store.put(Buffer.from('fresh'), meta(project.id, 'fresh.txt'));

    expect(await store.purge(new Date('2021-01-01T00:00:00Z'), project.id)).toBe(1);
    expect(await store.stat(oldId)).toBeUndefined();
    expect(existsSync(join(root, oldRec?.path ?? ''))).toBe(false);
    expect(await store.stat(freshId)).toBeDefined();
    expect(await store.stat(otherId)).toBeDefined();
  });

  it('runRetention uses each project retentionDays', async () => {
    const { db, store, project } = await storeSetup();
    await repos.projects.update(db, project.id, { retentionDays: 7 });
    const id = await store.put(Buffer.from('x'), meta(project.id));
    db.sqlite.prepare('UPDATE artifacts SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 10 * 86_400_000).toISOString(), id);
    const young = await store.put(Buffer.from('y'), meta(project.id, 'y.txt'));
    db.sqlite.prepare('UPDATE artifacts SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * 86_400_000).toISOString(), young);
    expect(await runRetention(db, store)).toEqual({ SHOP: 1 });
    expect(await store.stat(id)).toBeUndefined();
    expect(await store.stat(young)).toBeDefined();
  });
});

describe('parseRange', () => {
  it('handles open, suffix and invalid ranges', () => {
    expect(parseRange(undefined, 100)).toBeUndefined();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-2', 100)).toBe('invalid');
  });
});

describe('artifacts from a run', () => {
  let fixture: FixtureServer;
  beforeAll(async () => {
    fixture = await startFixtureServer();
  });
  afterAll(async () => {
    await fixture.close();
  });

  it('stores per-step screenshots, trace zip and video, serves them with ranges, and retention purges them', async () => {
    const dataDir = tmp();
    const db: Db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
    const config = loadConfig({ dataDir, logLevel: 'silent', workers: 0 }, {});
    const log = createLogger({ level: 'silent' });
    const app = await buildApp(config, {
      db,
      dev: true,
      workers: 1,
      workerOptions: {
        pollMs: 50,
        capture: { video: true },
        createModels: (settings) => {
          const mock = new MockDecisionModel({ fallback: mockResolver(loadMockScript(join(casesDir, 'tc-042.mock.json'))) });
          const s1: DecisionModel = { capabilities: mock.capabilities, decide: (req) => mock.decide(req) };
          return { s1, thresholds: settings.thresholds, modelName: 'mock' };
        },
      },
    });
    cleanups.push(async () => {
      await app.close();
      db.close();
    });
    const api = createCallerFactory(appRouter)(createContext({ db, config, log, runtime: runtimeFor({ db, config, log }) }));
    const vars = { search_term: 't-shirt', shipping_name: 'Alex Doe', shipping_zip: '94105' };
    const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: `${fixture.url}/shop` });
    const [dev] = await repos.environments.listByProject(db, project.id);
    await repos.environments.update(db, dev?.id ?? '', {
      variables: Object.entries(vars).map(([key, value]) => ({ key, value, secret: false, source: 'inline' as const })),
    });
    await api.models.updateSettings({
      target: 'SHOP',
      settings: { system1: { adapter: 'mock', model: 'mock' }, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, dualOrderSensitive: false },
    });
    const file = TestCaseFileSchema.omit({ key: true }).parse(loadCaseFile(join(casesDir, 'tc-042.yaml')));
    const tc = await api.cases.create({ projectKey: 'SHOP', ...file });
    const created = await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' });

    let run = await api.runs.get(created.id);
    for (const start = Date.now(); !['passed', 'failed', 'error'].includes(run.status); run = await api.runs.get(created.id)) {
      if (Date.now() - start > 90_000) throw new Error('run did not finish');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(run.status).toBe('passed');

    const steps = await repos.results.listSteps(db, run.results[0]?.id ?? '');
    expect(steps).toHaveLength(4);
    steps.forEach((s) => expect(s.evidence.filter((e) => e.kind === 'screenshot')).toHaveLength(1));
    const caseLevel = steps[3]?.evidence.map((e) => e.kind).filter((k) => k !== 'screenshot').sort();
    expect(caseLevel).toEqual(['console', 'log', 'network', 'trace', 'video']);
    const work = join(config.artifactsDir, '.work', created.id);
    expect(existsSync(work) ? readdirSync(work) : []).toEqual([]); // work files were moved into the store

    const shot = steps[0]?.evidence.find((e) => e.kind === 'screenshot');
    const png = await app.inject({ method: 'GET', url: `/api/artifacts/${shot?.artifactId}` });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');

    const trace = steps[3]?.evidence.find((e) => e.kind === 'trace');
    const zip = await app.inject({ method: 'GET', url: `/api/artifacts/${trace?.artifactId}` });
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');
    const viewer = await app.inject({ method: 'GET', url: `/api/artifacts/${trace?.artifactId}/trace-viewer` });
    expect(viewer.json<{ command: string }>().command).toMatch(/^npx playwright show-trace http/);

    const videoId = steps[3]?.evidence.find((e) => e.kind === 'video')?.artifactId;
    const full = await app.inject({ method: 'GET', url: `/api/artifacts/${videoId}` });
    expect(full.headers['accept-ranges']).toBe('bytes');
    const total = full.rawPayload.length;
    const part = await app.inject({ method: 'GET', url: `/api/artifacts/${videoId}`, headers: { range: 'bytes=0-99' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-99/${total}`);
    expect(part.rawPayload.equals(full.rawPayload.subarray(0, 100))).toBe(true);
    const tail = await app.inject({ method: 'GET', url: `/api/artifacts/${videoId}`, headers: { range: 'bytes=-50' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(full.rawPayload.subarray(total - 50))).toBe(true);
    const bad = await app.inject({ method: 'GET', url: `/api/artifacts/${videoId}`, headers: { range: `bytes=${total + 5}-` } });
    expect(bad.statusCode).toBe(416);
    expect((await app.inject({ method: 'GET', url: '/api/artifacts/nope' })).statusCode).toBe(404);

    // Retention purges files and rows.
    const store = new FsArtifactStore(db, config.artifactsDir);
    const record = await store.stat(videoId ?? '');
    expect(existsSync(join(config.artifactsDir, record?.path ?? ''))).toBe(true);
    const removed = await runRetention(db, store, new Date(Date.now() + 40 * 86_400_000));
    expect(removed['SHOP']).toBeGreaterThanOrEqual(9);
    expect(existsSync(join(config.artifactsDir, record?.path ?? ''))).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/api/artifacts/${videoId}` })).statusCode).toBe(404);
    const after = await repos.results.listSteps(db, run.results[0]?.id ?? '');
    expect(after.flatMap((s) => s.evidence)).toHaveLength(0);
  });
});
