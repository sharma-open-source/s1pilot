import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { FsArtifactStore } from '../artifacts/store.js';
import { loadConfig } from '../config.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';

const makeCaller = createCallerFactory(appRouter);
const log = createLogger({ level: 'silent' });
const dbs: Db[] = [];
const dirs: string[] = [];
const servers: Server[] = [];
const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  servers.splice(0).forEach((s) => s.close());
  dbs.splice(0).forEach((d) => d.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

interface Call {
  method: string;
  url: string;
  body: string;
}

/** Fake Jira / GitHub: records calls; `state` drives the status answered for issue lookups. */
async function fakeTracker(state: { jira: 'new' | 'indeterminate' | 'done'; github: 'open' | 'closed' }) {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      calls.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('latin1') });
      res.setHeader('content-type', 'application/json');
      const json = (v: unknown, status = 200) => {
        res.statusCode = status;
        res.end(JSON.stringify(v));
      };
      if (url === '/rest/api/3/myself') return json({ displayName: 'Quinn QA' });
      if (url === '/rest/api/3/project/SHOP') return json({ key: 'SHOP' });
      if (req.method === 'POST' && url === '/rest/api/3/issue') return json({ id: '1', key: 'SHOP-17' }, 201);
      if (url.endsWith('/attachments')) return json([{ id: 'a1' }]);
      if (url.endsWith('/comment')) return json({}, 201);
      if (url.startsWith('/rest/api/3/issue/SHOP-17')) {
        return json({ fields: { status: { name: state.jira, statusCategory: { key: state.jira } } } });
      }
      if (url === '/user') return json({ login: 'quinn' });
      if (url === '/repos/acme/shop') return json({ full_name: 'acme/shop' });
      if (req.method === 'POST' && url === '/repos/acme/shop/issues') return json({ number: 9, html_url: 'https://github.test/acme/shop/issues/9' }, 201);
      if (url === '/repos/acme/shop/issues/9') return json({ state: state.github });
      if (url === '/repos/acme/shop/issues/9/comments') return json({}, 201);
      return json({ message: 'not found' }, 404);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const dir = mkdtempSync(join(tmpdir(), 's1pilot-trackers-'));
  dirs.push(dir);
  const config = loadConfig({ dataDir: join(dir, '.s1pilot'), logLevel: 'silent' }, {});
  const ctx = createContext({ db, config, log });
  const api = makeCaller(ctx);
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  const env = await repos.environments.create(db, { id: newId(), projectId: project.id, name: 'staging', baseUrl: 'http://a.test' });
  const testCase = await api.cases.create({
    projectKey: 'SHOP',
    title: 'Cart badge',
    steps: [{ action: 'Open the shop' }, { action: 'Add "Classic Tee" to the cart', expected: 'Badge shows 1' }],
  });
  await repos.runs.create(db, { id: 'run1', projectId: project.id, trigger: 'manual', status: 'failed', buildRef: 'abc1234' });
  await repos.results.createCase(db, { id: 'cr1', runId: 'run1', caseId: testCase.id, caseVersion: 1, environmentId: env.id, verdict: 'failed', durationMs: 5, mode: 'replay', browser: 'chromium' });
  const store = new FsArtifactStore(db, config.artifactsDir);
  const shotId = await store.put(PNG, { projectId: project.id, runId: 'run1', caseResultId: 'cr1', stepIndex: 1, kind: 'screenshot', name: 'step-02.png', contentType: 'image/png' });
  const defect = await api.defects.create({
    projectKey: 'SHOP',
    title: 'Cart badge shows 2',
    severity: 'S2',
    details: {
      stepsToReproduce: ['Open the shop', 'Add "Classic Tee" to the cart'],
      expected: 'Badge shows 1',
      actual: 'Badge shows 2',
      environment: 'staging',
      browser: 'chromium',
      buildRef: 'abc1234',
      evidence: [{ artifactId: shotId, kind: 'screenshot' }],
      retest: true,
    },
    resultIds: ['cr1'],
  });
  return { db, ctx, api, config, project, defect };
}

const TOKEN = 'jira-secret-token-123';

async function connectJira(api: Awaited<ReturnType<typeof setup>>['api'], url: string) {
  await api.trackers.connect({ provider: 'jira', baseUrl: url, email: 'qa@acme.test', token: TOKEN });
  await api.trackers.setMapping({ projectKey: 'SHOP', mapping: { provider: 'jira', jiraProject: 'SHOP' } });
}

describe('trackers', () => {
  it('pushes a defect with repro steps, expected / actual, environment and the screenshot', async () => {
    const s = await setup();
    const fake = await fakeTracker({ jira: 'new', github: 'open' });
    await connectJira(s.api, fake.url);
    expect(await s.api.trackers.mapping({ projectKey: 'SHOP' })).toMatchObject({ provider: 'jira', label: 'Jira project SHOP', connected: true });

    const pushed = await s.api.trackers.push(s.defect.id);
    expect(pushed.external).toEqual({ provider: 'jira', id: 'SHOP-17', url: `${fake.url}/browse/SHOP-17` });

    const create = fake.calls.find((c) => c.method === 'POST' && c.url === '/rest/api/3/issue');
    const body = create?.body ?? '';
    for (const text of ['Cart badge shows 2', 'Open the shop', 'Badge shows 1', 'Badge shows 2', 'Environment: staging', 'Browser: chromium', 'Build: abc1234']) {
      expect(body).toContain(text);
    }
    const upload = fake.calls.find((c) => c.url === '/rest/api/3/issue/SHOP-17/attachments');
    expect(upload?.body).toContain('filename="step-02.png"');
    expect(upload?.body).toContain(PNG.toString('latin1'));

    const row = (await s.api.defects.list({ projectKey: 'SHOP' })).items[0];
    expect(row?.tracker).toEqual({ provider: 'jira', id: 'SHOP-17', url: `${fake.url}/browse/SHOP-17` });
    await expect(s.api.trackers.push(s.defect.id)).rejects.toMatchObject({ cause: { code: 'INVALID_STATE' } });
  });

  it('closes externally -> local fixed -> re-test queued, and leaves unchanged states alone', async () => {
    const s = await setup();
    const state = { jira: 'new' as 'new' | 'indeterminate' | 'done', github: 'open' as const };
    const fake = await fakeTracker(state);
    await connectJira(s.api, fake.url);
    await s.api.trackers.push(s.defect.id);

    expect(await s.api.trackers.syncNow({})).toEqual({ checked: 1, updated: 0 });
    state.jira = 'indeterminate';
    expect(await s.api.trackers.syncNow({ projectKey: 'SHOP' })).toEqual({ checked: 1, updated: 1 });
    expect((await s.api.defects.get(s.defect.id)).defect.status).toBe('in-progress');

    // A local edit is not overwritten while the tracker state stays the same.
    await s.api.defects.update({ id: s.defect.id, status: 'open' });
    await s.api.trackers.syncNow({});
    expect((await s.api.defects.get(s.defect.id)).defect.status).toBe('open');

    state.jira = 'done';
    expect(await s.api.trackers.syncNow({})).toEqual({ checked: 1, updated: 1 });
    const after = (await s.api.defects.get(s.defect.id)).defect;
    expect(after.status).toBe('fixed');
    const retests = (await repos.runs.listByProject(s.db, s.project.id, 10)).filter((r) => r.trigger === 'retest');
    expect(retests).toHaveLength(1);
    expect(after.details?.retestRunId).toBe(retests[0]?.id);
    expect(fake.calls.some((c) => c.url === '/rest/api/3/issue/SHOP-17/comment' && c.body.includes('re-test'))).toBe(true);
  });

  it('never returns credentials and stores the token encrypted', async () => {
    const s = await setup();
    const fake = await fakeTracker({ jira: 'new', github: 'open' });
    await connectJira(s.api, fake.url);
    const { path } = await s.api.trackers.rotateWebhook('jira');
    const listed = await s.api.trackers.list();
    const everything = JSON.stringify([listed, await s.api.trackers.mapping({ projectKey: 'SHOP' })]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(path.split('/').at(-1) as string);
    expect(listed.find((t) => t.provider === 'jira')).toMatchObject({ connected: true, baseUrl: fake.url, email: 'qa@acme.test', webhookEnabled: true });
    expect(JSON.stringify(await repos.settings.get(s.db, 'tracker.connection:jira'))).not.toContain(TOKEN);
    // Editing without a token keeps the stored one.
    await s.api.trackers.connect({ provider: 'jira', baseUrl: fake.url, email: 'qa@acme.test' });
    expect((await s.api.trackers.test({ provider: 'jira', baseUrl: fake.url, email: 'qa@acme.test' })).ok).toBe(true);
  });

  it('rejects bad credentials without saving, and push without mapping / connection', async () => {
    const s = await setup();
    await expect(s.api.trackers.push(s.defect.id)).rejects.toMatchObject({ cause: { code: 'TRACKER_NOT_MAPPED' } });
    await s.api.trackers.setMapping({ projectKey: 'SHOP', mapping: { provider: 'github', githubRepo: 'acme/shop' } });
    await expect(s.api.trackers.push(s.defect.id)).rejects.toMatchObject({ cause: { code: 'TRACKER_NOT_CONNECTED' } });
    const dead = await fakeTracker({ jira: 'new', github: 'open' });
    const unreachable = `${dead.url.replace(/:\d+$/, '')}:1`;
    await expect(s.api.trackers.connect({ provider: 'jira', baseUrl: unreachable, email: 'a@b.c', token: TOKEN })).rejects.toMatchObject({ cause: { code: 'TRACKER_CONNECTION' } });
    expect((await s.api.trackers.list()).every((t) => !t.connected)).toBe(true);
    await expect(s.api.trackers.setMapping({ projectKey: 'SHOP', mapping: { provider: 'github', githubRepo: 'nope' } })).rejects.toThrow(/owner\/name/);
  });

  it('applies a GitHub webhook (closed -> fixed) only with the right secret', async () => {
    const s = await setup();
    const fake = await fakeTracker({ jira: 'new', github: 'open' });
    await s.api.trackers.connect({ provider: 'github', baseUrl: fake.url, token: 'ghp_secret' });
    await s.api.trackers.setMapping({ projectKey: 'SHOP', mapping: { provider: 'github', githubRepo: 'acme/shop' } });
    await s.api.trackers.push(s.defect.id);
    const { path } = await s.api.trackers.rotateWebhook('github');

    const app = await buildApp(s.config, { db: s.db, workers: 0, dev: true, scheduler: false, trackerSync: false });
    closers.push(() => app.close());
    const payload = { action: 'closed', issue: { number: 9, state: 'closed', state_reason: 'completed' }, repository: { full_name: 'acme/shop' } };
    expect((await app.inject({ method: 'POST', url: '/api/hooks/trackers/github/wrong', payload })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/hooks/trackers/linear/x', payload })).statusCode).toBe(404);
    const res = await app.inject({ method: 'POST', url: path, payload });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ matched: true });
    expect((await s.api.defects.get(s.defect.id)).defect.status).toBe('fixed');
    expect((await repos.runs.listByProject(s.db, s.project.id, 10)).filter((r) => r.trigger === 'retest')).toHaveLength(1);
  }, 30_000);
});
