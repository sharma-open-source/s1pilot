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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';

import type { ModelFactory } from './models.js';
import { createRuntime, type ServerRuntime } from './runtime.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const casesDir = fileURLToPath(new URL('../../../../fixtures/sites/cases/shop/', import.meta.url));
const makeCaller = createCallerFactory(appRouter);
const VARS = { search_term: 't-shirt', shipping_name: 'Alex Doe', shipping_zip: '94105' };

let fixture: FixtureServer;
beforeAll(async () => {
  fixture = await startFixtureServer();
});
afterAll(async () => {
  await fixture.close();
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('expected a value');
  return v;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A mock System 1 for TC-42, optionally slowed down or hanging. */
function mockFactory(opts: { delayMs?: number; hang?: boolean } = {}): ModelFactory {
  return (settings) => {
    const script = loadMockScript(join(casesDir, 'tc-042.mock.json'));
    const mock = new MockDecisionModel({ fallback: mockResolver(script) });
    const s1: DecisionModel = {
      capabilities: mock.capabilities,
      async decide(req) {
        if (opts.hang) return new Promise(() => undefined);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return mock.decide(req);
      },
    };
    return { s1, thresholds: settings.thresholds, modelName: 'mock' };
  };
}

async function setup(opts: { model?: Parameters<typeof mockFactory>[0]; workers?: number; lease?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 's1p-runs-'));
  const db: Db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  const config = loadConfig({ dataDir, logLevel: 'silent', workers: 0 }, {});
  const log = createLogger({ level: 'silent' });
  const runtime: ServerRuntime = createRuntime({
    db,
    config,
    log,
    workerOptions: {
      createModels: mockFactory(opts.model),
      pollMs: 50,
      leaseMs: opts.lease ?? 30_000,
      ...(opts.lease ? { heartbeatMs: 100 } : {}),
    },
  });
  cleanups.push(async () => {
    await runtime.workers.stop();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const api = makeCaller(createContext({ db, config, log, runtime }));
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: `${fixture.url}/shop` });
  const [dev] = await repos.environments.listByProject(db, project.id);
  await repos.environments.update(db, must(dev).id, {
    variables: Object.entries(VARS).map(([key, value]) => ({ key, value, secret: false, source: 'inline' as const })),
  });
  await repos.environments.create(db, {
    id: 'bugenv00000000000000a',
    projectId: project.id,
    name: 'bug',
    baseUrl: `${fixture.url}/shop?bugs=shop.badge-wrong-count`,
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
  return { api, db, runtime, tc, events, file };
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

const finished = (api: Awaited<ReturnType<typeof setup>>['api'], runId: string) =>
  waitFor(async () => {
    const r = await api.runs.get(runId);
    return ['passed', 'failed', 'needs-review', 'cancelled', 'error'].includes(r.status) ? r : undefined;
  });

describe('runs: create → queue → worker → persisted results', () => {
  it('runs TC-42 against the fixture site to passed, persists steps, learns a script and replays it', async () => {
    const { api, db, runtime, tc, events } = await setup();
    runtime.workers.start(1);
    const created = await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' });
    expect(created.status).toBe('queued');

    const run = await finished(api, created.id);
    expect(run.status).toBe('passed');
    expect(run.summary).toMatchObject({ passed: 1, failed: 0 });
    expect(run.startedAt).toBeDefined();
    expect(run.finishedAt).toBeDefined();
    expect(run.config).toMatchObject({ environment: 'dev', browser: 'chromium', mode: 'replay-heal' });
    expect(run.progress).toMatchObject({ total: 1, completed: 1 });
    expect(run.results).toHaveLength(1);
    expect(run.results[0]).toMatchObject({ key: tc.key, verdict: 'passed', mode: 'explore', caseVersion: 1 });

    const steps = await repos.results.listSteps(db, must(run.results[0]).id);
    expect(steps.map((s) => s.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(steps.flatMap((s) => s.decisions).length).toBeGreaterThan(0);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['run.started', 'case.started', 'step.finished', 'case.finished', 'run.finished']));
    expect(events.filter((e) => e.type === 'run.finished')).toHaveLength(1);
    expect(await repos.learnedScripts.listByCase(db, tc.id)).toHaveLength(1);

    const listed = await api.runs.list({ projectKey: 'SHOP' });
    expect(listed.map((r) => r.id)).toEqual([created.id]);

    // The second run replays the learned script from the database.
    const second = await finished(api, (await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' })).id);
    expect(second.status).toBe('passed');
    expect(second.results[0]?.mode).toBe('replay');

    // Paged listing: newest first, total across pages, `finished` keeps both (neither is live).
    const first = await api.runs.page({ projectKey: 'SHOP', pageSize: 1 });
    expect(first).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(first.items.map((r) => r.id)).toEqual([second.id]);
    expect((await api.runs.page({ projectKey: 'SHOP', pageSize: 1, page: 2 })).items.map((r) => r.id)).toEqual([created.id]);
    expect((await api.runs.page({ projectKey: 'SHOP', finished: true })).total).toBe(2);
  });

  it('rejects unknown environments and cases', async () => {
    const { api, tc } = await setup();
    await expect(api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(api.runs.create({ projectKey: 'SHOP', caseKeys: ['SHOP-TC-99'], environment: 'dev' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(api.runs.get('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('errors the run when no model is configured', async () => {
    const { api, runtime, tc } = await setup();
    await api.models.updateSettings({ target: 'SHOP', settings: null });
    runtime.workers.start(1);
    const run = await finished(api, (await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' })).id);
    expect(run.status).toBe('error');
    expect(run.jobs[0]).toMatchObject({ status: 'failed', attempts: 1, error: expect.stringContaining('No System 1 model') });
  });
});

describe('runs: worker death', () => {
  it('retries a job once after its lease expires, then marks the run error', async () => {
    const { api, runtime, tc } = await setup({ model: { hang: true }, lease: 500 });
    runtime.workers.start(3);
    const created = await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' });
    const jobOf = async () => must((await runtime.queue.listByRun(created.id))[0]);

    const first = await waitFor(async () => {
      const j = await jobOf();
      return j.status === 'running' ? j : undefined;
    });
    expect(first.attempts).toBe(1);
    runtime.workers.crash(must(first.workerId));

    const second = await waitFor(async () => {
      const j = await jobOf();
      return j.status === 'running' && j.attempts === 2 ? j : undefined;
    });
    expect(second.workerId).not.toBe(first.workerId);
    runtime.workers.crash(must(second.workerId));

    const run = await finished(api, created.id);
    expect(run.status).toBe('error');
    expect(run.jobs[0]).toMatchObject({ status: 'failed', attempts: 2, error: expect.stringContaining('lease expired') });
  });
});

describe('runs: cancel', () => {
  it('cancels queued jobs and aborts the running one within 5 s', async () => {
    const { api, runtime, tc, file, events } = await setup({ model: { delayMs: 1500 } });
    const second = await api.cases.create({ projectKey: 'SHOP', ...file, title: 'Second' });
    runtime.workers.start(1);
    const created = await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key, second.key], environment: 'dev' });

    await waitFor(async () => (await runtime.queue.listByRun(created.id)).some((j) => j.status === 'running'));
    await waitFor(() => events.some((e) => e.type === 'case.started'));
    const t0 = Date.now();
    const cancelled = await api.runs.cancel(created.id);
    const run = await finished(api, created.id);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(cancelled.status).toBe('cancelled');
    expect(run.status).toBe('cancelled');
    expect(run.jobs.map((j) => j.status)).toEqual(['cancelled', 'cancelled']);
    expect(run.results).toHaveLength(0);

    // The worker is free again: a new run is picked up.
    const next = await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key], environment: 'dev' });
    await waitFor(async () => (await runtime.queue.listByRun(next.id))[0]?.status === 'running');
    await api.runs.cancel(next.id);
    await expect(api.runs.cancel(next.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('runs: rerunFailed', () => {
  it('creates a new run with only the failed instances', async () => {
    const { api, runtime, tc, file } = await setup();
    // A second case that only opens the product, so it still passes with the seeded bug.
    const opens = await api.cases.create({ projectKey: 'SHOP', ...file, title: 'Open product', steps: [must(file.steps[0])], parameters: [] });
    runtime.workers.start(2);
    const first = await finished(
      api,
      (await api.runs.create({ projectKey: 'SHOP', caseKeys: [tc.key, opens.key], environment: 'bug', browser: 'chromium', mode: 'explore' })).id,
    );
    expect(first.status).toBe('failed');
    expect(first.summary).toMatchObject({ passed: 1, failed: 1 });

    const rerun = await api.runs.rerunFailed(first.id);
    expect(rerun.id).not.toBe(first.id);
    const jobs = await runtime.queue.listByRun(rerun.id);
    expect(jobs).toHaveLength(1);
    expect((must(jobs[0]).payload as { caseId: string }).caseId).toBe(tc.id);
    expect((must(jobs[0]).payload as { mode: string }).mode).toBe('explore');
    const done = await finished(api, rerun.id);
    expect(done.status).toBe('failed');
    expect(done.results.map((r) => r.key)).toEqual([tc.key]);

    await expect(api.runs.rerunFailed(first.id)).resolves.toBeDefined();
    const clean = await finished(api, (await api.runs.create({ projectKey: 'SHOP', caseKeys: [opens.key], environment: 'bug' })).id);
    expect(clean.status).toBe('passed');
    await expect(api.runs.rerunFailed(clean.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});
