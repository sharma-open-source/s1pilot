import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { TestCaseFileSchema, type DecisionModel } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, loadMockScript, mockResolver } from '@s1pilot/providers';
import { launchBrowser } from '@s1pilot/runner';
import { loadCaseFile } from '@s1pilot/sync';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';

import type { ModelFactory } from './models.js';
import { createRuntime } from './runtime.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const casesDir = fileURLToPath(new URL('../../../../fixtures/sites/cases/shop/', import.meta.url));
const makeCaller = createCallerFactory(appRouter);
const VARS = { search_term: 't-shirt', shipping_name: 'Alex Doe', shipping_zip: '94105' };
const variables = Object.entries(VARS).map(([key, value]) => ({ key, value, secret: false, source: 'inline' as const }));

let fixture: FixtureServer;
beforeAll(async () => {
  fixture = await startFixtureServer();
});
afterAll(async () => {
  await fixture.close();
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Mock System 1 for TC-42 that records how many decisions run at once. */
function tracker(delayMs: number) {
  const state = { active: 0, max: 0 };
  const factory: ModelFactory = (settings) => {
    const mock = new MockDecisionModel({ fallback: mockResolver(loadMockScript(join(casesDir, 'tc-042.mock.json'))) });
    const s1: DecisionModel = {
      capabilities: mock.capabilities,
      async decide(req) {
        state.active++;
        state.max = Math.max(state.max, state.active);
        try {
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          return await mock.decide(req);
        } finally {
          state.active--;
        }
      },
    };
    return { s1, thresholds: settings.thresholds, modelName: 'mock' };
  };
  return { state, factory };
}

async function setup(opts: { delayMs?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 's1p-matrix-'));
  const db: Db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  const config = loadConfig({ dataDir, logLevel: 'silent', workers: 0 }, {});
  const log = createLogger({ level: 'silent' });
  const t = tracker(opts.delayMs ?? 0);
  const runtime = createRuntime({
    db,
    config,
    log,
    // Only Chromium is installed in CI: every browser name maps to it, the job payload still carries the name.
    workerOptions: { createModels: t.factory, pollMs: 50, launch: () => launchBrowser('chromium') },
  });
  cleanups.push(async () => {
    await runtime.workers.stop();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const api = makeCaller(createContext({ db, config, log, runtime }));
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: `${fixture.url}/shop` });
  const [dev] = await repos.environments.listByProject(db, project.id);
  if (!dev) throw new Error('no default environment');
  await repos.environments.update(db, dev.id, { variables });
  await api.models.updateSettings({
    target: 'SHOP',
    settings: { system1: { adapter: 'mock', model: 'mock' }, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, dualOrderSensitive: false },
  });
  const file = TestCaseFileSchema.omit({ key: true }).parse(loadCaseFile(join(casesDir, 'tc-042.yaml')));
  const tc = await api.cases.create({ projectKey: 'SHOP', ...file });
  return { api, db, runtime, tc, dev, project, tracker: t.state };
}

type Api = Awaited<ReturnType<typeof setup>>['api'];

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 150_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const finished = (api: Api, runId: string) =>
  waitFor(async () => {
    const r = await api.runs.get(runId);
    return ['passed', 'failed', 'needs-review', 'cancelled', 'error'].includes(r.status) ? r : undefined;
  });

describe('retries and flaky detection', () => {
  it('a failure that passes on retry becomes flaky, keeps both attempts and scores the case', async () => {
    const { api, db, runtime, tc, project } = await setup();
    // Every second browser session of the fixture shows the wrong badge: the first session fails, the retry passes.
    const flakySite = await startFixtureServer();
    cleanups.push(() => flakySite.close());
    const env = await repos.environments.create(db, {
      id: 'flakyenv000000000000a',
      projectId: project.id,
      name: 'flaky',
      baseUrl: `${flakySite.url}/shop?bugs=shop.flaky-badge`,
      variables,
    });
    const plan = await api.plans.create({
      projectKey: 'SHOP',
      name: 'Flaky',
      selection: { kind: 'list', caseIds: [tc.id] },
      matrix: [{ environmentId: env.id, browser: 'chromium' }],
      retries: 1,
      mode: 'explore',
    });
    runtime.workers.start(1);
    const run = await finished(api, (await api.runs.create({ projectKey: 'SHOP', planId: plan.id })).id);

    expect(run.results.map((r) => [r.attempt, r.verdict])).toEqual(
      expect.arrayContaining([
        [1, 'failed'],
        [2, 'flaky'],
      ]),
    );
    expect(run.results).toHaveLength(2);
    // Both attempts keep their steps; the summary counts the final attempt only.
    for (const r of run.results) expect((await repos.results.listSteps(db, r.id)).length).toBeGreaterThan(0);
    expect(run.summary).toMatchObject({ flaky: 1, failed: 0, passed: 0 });

    const stored = await api.cases.get({ key: tc.key });
    expect(stored.flakiness).toBeGreaterThan(0);
    const top = await api.cases.flaky({ projectKey: 'SHOP' });
    expect(top.map((c) => c.key)).toEqual([tc.key]);
  });

  it('does not retry passing runs and records no extra attempts', async () => {
    const { api, runtime, tc, dev } = await setup();
    const plan = await api.plans.create({
      projectKey: 'SHOP',
      name: 'Stable',
      selection: { kind: 'list', caseIds: [tc.id] },
      matrix: [{ environmentId: dev.id, browser: 'chromium' }],
      retries: 2,
      mode: 'explore',
    });
    runtime.workers.start(1);
    const run = await finished(api, (await api.runs.create({ projectKey: 'SHOP', planId: plan.id })).id);
    expect(run.results.map((r) => [r.attempt, r.verdict])).toEqual([[1, 'passed']]);
    expect((await api.cases.get({ key: tc.key })).flakiness).toBe(0);
  });
});

describe('matrix runs', () => {
  it('2 environments x 3 browsers = 6 instances, run in parallel up to the plan limit', async () => {
    const { api, db, runtime, tc, dev, project, tracker: seen } = await setup({ delayMs: 150 });
    const staging = await repos.environments.create(db, {
      id: 'stagingenv00000000000a',
      projectId: project.id,
      name: 'staging',
      baseUrl: `${fixture.url}/shop`,
      variables,
    });
    const browsers = ['chromium', 'firefox', 'webkit'] as const;
    const plan = await api.plans.create({
      projectKey: 'SHOP',
      name: 'Matrix',
      selection: { kind: 'list', caseIds: [tc.id] },
      matrix: [dev, staging].flatMap((e) => browsers.map((browser) => ({ environmentId: e.id, browser }))),
      parallelism: 2,
      mode: 'explore',
    });
    const preview = await api.plans.preview({ projectKey: 'SHOP', ...plan });
    expect(preview.jobs).toBe(6);

    // More workers than the plan allows: the plan's parallelism is the cap.
    runtime.workers.start(4);
    const run = await finished(api, (await api.runs.create({ projectKey: 'SHOP', planId: plan.id })).id);
    expect(run.status).toBe('passed');
    expect(run.jobs).toHaveLength(6);
    expect(run.results).toHaveLength(6);
    expect(run.summary).toMatchObject({ passed: 6 });
    const targets = new Set(run.results.map((r) => `${r.environmentId}|${r.browser}`));
    expect(targets.size).toBe(6);
    expect(seen.max).toBe(2);
  });

  it('parallelism is a cap, not a repeat count: one case on one target runs once with 4 workers', async () => {
    const { api, runtime, tc, dev } = await setup();
    const plan = await api.plans.create({
      projectKey: 'SHOP',
      name: 'Four workers',
      selection: { kind: 'list', caseIds: [tc.id] },
      matrix: [{ environmentId: dev.id, browser: 'chromium' }],
      parallelism: 4,
      mode: 'explore',
    });
    expect(await api.plans.preview({ projectKey: 'SHOP', ...plan })).toMatchObject({ jobs: 1 });
    runtime.workers.start(4);
    const run = await finished(api, (await api.runs.create({ projectKey: 'SHOP', planId: plan.id })).id);
    expect(run.jobs).toHaveLength(1);
    expect(run.results).toHaveLength(1);
    expect(run.summary).toMatchObject({ passed: 1 });
  });

  it('a device descriptor is applied to the browser context, unknown devices fail the job', async () => {
    const { api, runtime, tc, dev } = await setup();
    const plan = await api.plans.create({
      projectKey: 'SHOP',
      name: 'Phone',
      selection: { kind: 'list', caseIds: [tc.id] },
      matrix: [{ environmentId: dev.id, browser: 'chromium', device: 'No Such Phone' }],
    });
    runtime.workers.start(1);
    const run = await finished(api, (await api.runs.create({ projectKey: 'SHOP', planId: plan.id })).id);
    expect(run.status).toBe('error');
    expect(run.jobs[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('Unknown device') });
  });
});

describe('quarantine', () => {
  it('skips quarantined cases in plan runs and reports them as skipped (quarantined)', async () => {
    const { api, db, runtime, tc, dev } = await setup();
    const other = await api.cases.create({ projectKey: 'SHOP', title: 'Unstable login', steps: [{ action: 'Open the shop' }] });
    await expect(api.cases.quarantine({ key: other.key, reason: '' })).rejects.toThrow();
    await api.cases.quarantine({ key: other.key, reason: 'login times out' });
    expect((await api.cases.list({ projectKey: 'SHOP', query: 'quarantined:yes' })).items.map((c) => c.key)).toEqual([other.key]);

    const plan = await api.plans.create({
      projectKey: 'SHOP',
      name: 'Both',
      selection: { kind: 'list', caseIds: [tc.id, other.id] },
      matrix: [{ environmentId: dev.id, browser: 'chromium' }],
      mode: 'explore',
    });
    expect(await api.plans.preview({ projectKey: 'SHOP', ...plan })).toMatchObject({ quarantined: 1, jobs: 1 });
    runtime.workers.start(1);
    const run = await finished(api, (await api.runs.create({ projectKey: 'SHOP', planId: plan.id })).id);
    expect(run.status).toBe('passed');
    expect(run.summary).toMatchObject({ passed: 1, skipped: 1 });
    const skipped = run.results.find((r) => r.caseId === other.id);
    expect(skipped).toMatchObject({ verdict: 'skipped', reason: 'quarantined' });
    const report = await api.runs.report(run.id);
    expect(report.results.find((r) => r.caseId === other.id)).toMatchObject({ verdict: 'skipped', reason: 'quarantined', note: 'skipped (quarantined)' });
    expect(await repos.results.listCases(db, run.id)).toHaveLength(2);

    // Lifting the quarantine puts the case back in plan runs.
    await api.cases.unquarantine({ key: other.key, reason: 'fixed' });
    expect(await api.plans.preview({ projectKey: 'SHOP', ...plan })).toMatchObject({ quarantined: 0, jobs: 2 });
    expect((await api.dashboard.summary()).quarantined).toBe(0);
  });
});
