import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { TestCaseFileSchema, type DecisionModel, type RunEvent } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, loadMockScript, mockResolver } from '@s1pilot/providers';
import { loadCaseFile } from '@s1pilot/sync';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { buildApp } from '../app.js';
import { startFakeS3, type FakeS3 } from '../artifacts/fake-s3.js';
import { createApiToken } from '../auth/tokens.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { encodeFrame } from '../live/frame.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';
import type { ModelFactory } from '../worker/models.js';
import { runtimeFor } from '../worker/runtime.js';

import { RemoteWorker } from './client.js';
import { wrapFrame } from './protocol.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const casesDir = fileURLToPath(new URL('../../../../fixtures/sites/cases/shop/', import.meta.url));
const makeCaller = createCallerFactory(appRouter);
const VARS = { search_term: 't-shirt', shipping_name: 'Alex Doe', shipping_zip: '94105' };

let fixture: FixtureServer;
let s3: FakeS3;
beforeAll(async () => {
  fixture = await startFixtureServer();
  s3 = await startFakeS3();
  process.env['AWS_ACCESS_KEY_ID'] = 'test';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'test-secret';
});
afterAll(async () => {
  await fixture.close();
  await s3.close();
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected a value');
  return v;
}

/** A mock System 1 for TC-42; `hang` never answers (a worker stuck mid-job). */
function mockFactory(opts: { hang?: boolean } = {}): ModelFactory {
  return (settings) => {
    const mock = new MockDecisionModel({ fallback: mockResolver(loadMockScript(join(casesDir, 'tc-042.mock.json'))) });
    const s1: DecisionModel = {
      capabilities: mock.capabilities,
      decide: (req) => (opts.hang ? new Promise(() => undefined) : mock.decide(req)),
    };
    return { s1, thresholds: settings.thresholds, modelName: 'mock' };
  };
}

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 90_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function setup(opts: { s3?: boolean; leaseMs?: number; workerToken?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 's1p-remote-'));
  const db: Db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  const config: ServerConfig = loadConfig(
    { dataDir, logLevel: 'silent', workers: 0, ...(opts.workerToken ? { workerToken: opts.workerToken } : {}), ...(opts.s3 ? { s3Bucket: 'arts', s3Endpoint: s3.endpoint, s3Prefix: 's1p/' } : {}) },
    {},
  );
  const log = createLogger({ level: 'silent' });
  const app: FastifyInstance = await buildApp(config, {
    db,
    workers: 0,
    scheduler: false,
    trackerSync: false,
    dev: true,
    remote: { leaseMs: opts.leaseMs ?? 30_000, reapIntervalMs: 100 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const runtime = runtimeFor({ db, config, log });
  const { token } = await createApiToken(db, { name: 'worker', scopes: ['runs:write'], createdBy: 'test' });
  const workers: RemoteWorker[] = [];
  cleanups.push(async () => {
    for (const w of workers) await w.stop();
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const worker = (o: Partial<ConstructorParameters<typeof RemoteWorker>[0]> = {}): RemoteWorker => {
    const w = new RemoteWorker({ server: url, token, createModels: mockFactory(), pollMs: 50, workDir: dataDir, ...o });
    workers.push(w);
    return w;
  };

  const api = makeCaller(createContext({ db, config, log, runtime }));
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: `${fixture.url}/shop` });
  const [dev] = await repos.environments.listByProject(db, project.id);
  await repos.environments.update(db, must(dev).id, {
    variables: Object.entries(VARS).map(([key, value]) => ({ key, value, secret: false, source: 'inline' as const })),
  });
  await api.models.updateSettings({
    target: 'SHOP',
    settings: { system1: { adapter: 'mock', model: 'mock' }, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, dualOrderSensitive: false },
  });
  const file = TestCaseFileSchema.omit({ key: true }).parse(loadCaseFile(join(casesDir, 'tc-042.yaml')));
  const tc = await api.cases.create({ projectKey: 'SHOP', ...file });
  const events: RunEvent[] = [];
  runtime.bus.subscribe((e) => events.push(e));
  const plan = (workerLabels: string[]) =>
    api.plans.create({
      projectKey: 'SHOP',
      name: `Plan ${workerLabels.join(',') || 'any'}`,
      selection: { kind: 'list', caseIds: [tc.id] },
      matrix: [{ environmentId: must(dev).id, browser: 'chromium' }],
      workerLabels,
    });
  const finished = (runId: string) =>
    waitFor(async () => {
      const r = await api.runs.get(runId);
      return ['passed', 'failed', 'needs-review', 'cancelled', 'error'].includes(r.status) ? r : undefined;
    });
  return { app, url, token, db, runtime, api, tc, events, worker, plan, finished, config };
}

describe('remote worker runs a case end to end', () => {
  it('registers, leases, runs TC-42, uploads artifacts to S3 and serves them via presigned URLs', async () => {
    const { api, db, runtime, tc, events, worker, url, finished, config } = await setup({ s3: true });
    const w = worker({ labels: ['eu'], name: 'eu-1', version: '9.9.9' });
    await w.start();
    expect(runtime.remote.registry.list()).toMatchObject([{ id: w.id, name: 'eu-1', labels: ['eu'], version: '9.9.9', status: 'idle' }]);

    const created = await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' });
    const run = await finished(created.id);
    expect(run.status).toBe('passed');
    expect(run.summary).toMatchObject({ passed: 1, failed: 0 });
    expect(run.results[0]).toMatchObject({ key: tc.key, verdict: 'passed', mode: 'explore' });
    const job = must((await runtime.queue.listByRun(created.id))[0]);
    expect(job).toMatchObject({ status: 'completed', workerId: w.id });

    const steps = await repos.results.listSteps(db, must(run.results[0]).id);
    expect(steps.map((s) => s.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['run.started', 'case.started', 'step.finished', 'case.finished', 'run.finished']));
    expect(await repos.learnedScripts.listByCase(db, tc.id)).toHaveLength(1);

    // Artifacts live in the bucket, not on the server's disk, and the UI gets presigned URLs.
    expect(s3.objects.size).toBeGreaterThan(0);
    const artifacts = await repos.artifacts.listByCaseResult(db, must(run.results[0]).id);
    const shot = must(artifacts.find((a) => a.kind === 'screenshot'));
    expect(s3.objects.has(`arts/s1p/${shot.path}`)).toBe(true);
    const res = await fetch(`${url}/api/artifacts/${shot.id}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain(s3.endpoint);
    const bytes = Buffer.from(await (await fetch(location)).arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(config.s3Bucket).toBe('arts');

    // The replay run uses the learned script stored through the API.
    const second = await finished((await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' })).id);
    expect(second.results[0]?.mode).toBe('replay');
  });

  it('rejects calls without a token or with a read-only one', async () => {
    const { url, db } = await setup();
    const anon = await fetch(`${url}/api/workers/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(anon.status).toBe(401);
    const { token } = await createApiToken(db, { name: 'ro', scopes: ['results:read'], createdBy: 'test' });
    const ro = await fetch(`${url}/api/workers/register`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
    expect(ro.status).toBe(403);
    const bad = await fetch(`${url}/api/workers/nope/claim`, { method: 'POST', headers: { authorization: 'Bearer s1p_00000000_' + '0'.repeat(48) } });
    expect(bad.status).toBe(401);
  });
});

describe('remote worker disconnect', () => {
  it('re-queues the leased job after the lease expires and another worker finishes it', async () => {
    const { api, runtime, tc, worker, finished } = await setup({ leaseMs: 900 });
    const stuck = worker({ createModels: mockFactory({ hang: true }) });
    await stuck.start();
    const created = await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' });
    const jobOf = async () => must((await runtime.queue.listByRun(created.id))[0]);
    const first = await waitFor(async () => {
      const j = await jobOf();
      return j.status === 'running' && stuck.activeJobs === 1 ? j : undefined;
    });
    expect(first).toMatchObject({ attempts: 1, workerId: stuck.id });
    expect(runtime.remote.registry.list()[0]).toMatchObject({ status: 'busy' });

    stuck.crash(); // the machine disappears: no heartbeats, no report
    const requeued = await waitFor(async () => {
      const j = await jobOf();
      return j.status === 'queued' ? j : undefined;
    });
    expect(requeued.attempts).toBe(1);

    const healthy = worker();
    await healthy.start();
    const run = await finished(created.id);
    expect(run.status).toBe('passed');
    const job = await jobOf();
    expect(job).toMatchObject({ status: 'completed', attempts: 2, workerId: healthy.id });
    // The crashed worker shows as offline once its heartbeats stop.
    await waitFor(() => runtime.remote.registry.list().find((x) => x.id === stuck.id)?.status === 'offline');
  });

  it('fails the run when the job is lost on its last attempt', async () => {
    const { api, runtime, tc, worker, finished } = await setup({ leaseMs: 600 });
    const created = await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' });
    for (let i = 0; i < 2; i++) {
      const w = worker({ createModels: mockFactory({ hang: true }) });
      await w.start();
      await waitFor(() => w.activeJobs === 1);
      w.crash();
      await waitFor(async () => {
        const j = must((await runtime.queue.listByRun(created.id))[0]);
        return i === 0 ? j.status === 'queued' : j.status === 'failed';
      });
    }
    const run = await finished(created.id);
    expect(run.status).toBe('error');
    expect(run.jobs[0]).toMatchObject({ status: 'failed', attempts: 2, error: expect.stringContaining('lease expired') });
  });
});

describe('label routing', () => {
  it('sends labelled plan jobs only to workers carrying the labels', async () => {
    const { api, runtime, plan, worker, finished } = await setup();
    const plain = worker({ name: 'plain' });
    const gpu = worker({ name: 'gpu', labels: ['gpu', 'eu'] });
    await plain.start();
    await gpu.start();

    const gpuPlan = await plan(['gpu']);
    expect(gpuPlan.workerLabels).toEqual(['gpu']);
    const labelled = await api.runs.create({ projectKey: 'SHOP', planId: gpuPlan.id });
    const [job] = await runtime.queue.listByRun(labelled.id);
    expect(job).toMatchObject({ labels: ['gpu'], payload: { workerLabels: ['gpu'] } });
    const run = await finished(labelled.id);
    expect(run.status).toBe('passed');
    expect(must((await runtime.queue.listByRun(labelled.id))[0]).workerId).toBe(gpu.id);
  });

  it('keeps a labelled job queued while no matching worker exists, and unlabelled jobs go to anyone', async () => {
    const { api, runtime, plan, worker, finished } = await setup();
    const plain = worker();
    await plain.start();
    const labelled = await api.runs.create({ projectKey: 'SHOP', planId: (await plan(['gpu'])).id });
    const anyRun = await api.runs.create({ projectKey: 'SHOP', planId: (await plan([])).id });
    expect((await finished(anyRun.id)).status).toBe('passed');
    expect(must((await runtime.queue.listByRun(anyRun.id))[0]).workerId).toBe(plain.id);
    // The plain worker polled for seconds meanwhile and never took the labelled job; neither does the local pool.
    expect(must((await runtime.queue.listByRun(labelled.id))[0])).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await runtime.remote.claim(plain.id)).toBeUndefined();
  });
});

describe('bootstrap worker token', () => {
  it('S1PILOT_WORKER_TOKEN lets workers register without creating a token first', async () => {
    const workerToken = `s1p_${'ab'.repeat(4)}_${'cd'.repeat(24)}`;
    const { worker, runtime, url } = await setup({ workerToken });
    const w = worker({ token: workerToken });
    await w.start();
    expect(runtime.remote.registry.list().map((x) => x.id)).toEqual([w.id]);
    const wrong = await fetch(`${url}/api/workers/register`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer s1p_${'ab'.repeat(4)}_${'ee'.repeat(24)}` }, body: '{}' });
    expect(wrong.status).toBe(401);
  });
});

describe('remote worker api', () => {
  it('lists remote workers for Settings › Workers', async () => {
    const { api, worker } = await setup();
    const w = worker({ labels: ['gpu'], name: 'gpu-box', version: '1.2.3', concurrency: 2 });
    await w.start();
    const { remote } = await api.workspace.workers();
    expect(remote).toMatchObject([{ id: w.id, name: 'gpu-box', labels: ['gpu'], version: '1.2.3', concurrency: 2, status: 'idle', jobs: [] }]);
    expect(remote[0]?.lastHeartbeatAt).toBeTruthy();
  });

  it('streams worker events and screencast frames to run subscribers over the WebSocket', async () => {
    const { api, runtime, url, token, tc, worker, events } = await setup({ leaseMs: 30_000 });
    const w = worker({ createModels: mockFactory({ hang: true }) });
    await w.start();
    const created = await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' });
    await waitFor(() => w.activeJobs === 1 && events.some((e) => e.type === 'case.started'));

    // A browser tab subscribes to the run: the server relays the demand to the worker's socket...
    const demands: Array<{ runId: string; subscribers: number }> = [];
    const probe = new WebSocket(`${url.replace('http', 'ws')}/ws/workers/${w.id}`, { headers: { authorization: `Bearer ${token}` } });
    probe.on('message', (d) => {
      const m = JSON.parse(String(d)) as { type: string; runId: string; subscribers: number };
      if (m.type === 'demand') demands.push(m);
    });
    await new Promise((r) => probe.once('open', r));
    const frames: Buffer[] = [];
    const remove = await runtime.live.subscribeRun(created.id, { sendText: () => undefined, sendBinary: (b) => frames.push(b) });
    await waitFor(() => demands.some((d) => d.runId === created.id && d.subscribers === 1));

    // ...and frames the worker sends come out at the subscriber.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    probe.send(wrapFrame(created.id, encodeFrame({ resultId: 'r1', seq: 1, width: 10, height: 20, data: jpeg })), { binary: true });
    await waitFor(() => frames.length > 0);
    expect(frames[0]?.subarray(-4)).toEqual(jpeg);
    // A frame for a run the worker is not executing is dropped.
    probe.send(wrapFrame('other-run', encodeFrame({ resultId: 'r1', seq: 2, width: 10, height: 20, data: jpeg })), { binary: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(frames).toHaveLength(1);
    remove?.();
    probe.close();
    await api.runs.cancel(created.id);
  });
});
