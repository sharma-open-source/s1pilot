import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { createLogger } from '@s1pilot/domain/logger';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel } from '@s1pilot/providers';
import { launchBrowser } from '@s1pilot/runner';
import type { Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';
import type { ModelFactory } from '../worker/models.js';
import { createRuntime } from '../worker/runtime.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const makeCaller = createCallerFactory(appRouter);
const PASSWORD = 'hunter2-Very-Secret';

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

let modelCalls = 0;
// Replay must never need a model: any call fails the run and the test.
const modelFactory: ModelFactory = (settings) => {
  const s1 = new MockDecisionModel({ fallback: () => ({}) });
  return {
    s1: {
      capabilities: s1.capabilities,
      decide: async () => {
        modelCalls++;
        throw new Error('replay must not call the model');
      },
    },
    thresholds: settings.thresholds,
    modelName: 'mock',
  };
};

async function setup(mode: 'local' | 'team' = 'local') {
  const dataDir = mkdtempSync(join(tmpdir(), 's1p-rec-'));
  const db: Db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  const config = loadConfig({ dataDir, logLevel: 'silent', workers: 0, mode }, {});
  const log = createLogger({ level: 'silent' });
  const runtime = createRuntime({
    db,
    config,
    log,
    launchHeaded: () => launchBrowser('chromium'),
    workerOptions: { createModels: modelFactory, pollMs: 50 },
  });
  cleanups.push(async () => {
    await runtime.recorder.close();
    await runtime.workers.stop();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const api = makeCaller(createContext({ db, config, log, runtime, ...(mode === 'team' ? { user: { id: 'admin-1', role: 'admin' as const } } : {}) }));
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: `${fixture.url}/shop` });
  const [env] = await repos.environments.listByProject(db, project.id);
  const environment = env as NonNullable<typeof env>;
  await repos.environments.update(db, environment.id, {
    variables: [
      { key: 'shipping_name', value: 'Alex Doe', secret: false, source: 'inline' },
      { key: 'shipping_zip', value: '94105', secret: false, source: 'inline' },
    ],
  });
  await api.models.updateSettings({
    target: 'SHOP',
    settings: { system1: { adapter: 'mock', model: 'mock' }, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, dualOrderSensitive: false },
  });
  return { api, db, runtime, environment };
}

async function guestCheckout(p: Page): Promise<void> {
  await p.getByRole('searchbox', { name: 'Search products' }).fill('t-shirt');
  await p.getByRole('button', { name: 'Search' }).click();
  await p.waitForURL(/search/);
  await p.getByRole('link', { name: 'Classic Tee' }).click();
  await p.waitForURL(/product/);
  await p.getByRole('radio', { name: 'Blue' }).check();
  await p.getByRole('radio', { name: 'M', exact: true }).check();
  await p.getByRole('button', { name: 'Add to cart' }).click();
  await p.getByRole('status', { name: 'Cart items' }).filter({ hasText: '1' }).waitFor();
  await p.getByRole('link', { name: /^Cart/ }).click();
  await p.waitForURL(/cart/);
  await p.getByRole('link', { name: 'Checkout' }).click();
  await p.waitForURL(/checkout/);
  await p.getByRole('button', { name: /guest/i }).click();
  await p.waitForURL(/shipping/);
  await p.getByLabel('Full name').fill('Alex Doe');
  await p.getByLabel('ZIP code').fill('94105');
  await p.getByRole('button', { name: 'Continue to payment' }).click();
  await p.waitForURL(/payment/);
}

async function waitForRun(api: Awaited<ReturnType<typeof setup>>['api'], id: string) {
  const start = Date.now();
  for (;;) {
    const run = await api.runs.get(id);
    if (['passed', 'failed', 'needs-review', 'cancelled', 'error'].includes(run.status)) return run;
    if (Date.now() - start > 90_000) throw new Error('run timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('recorder tRPC', () => {
  it('records the guest checkout into a draft case plus a learned script that replays without a model', async () => {
    const { api, runtime, db, environment } = await setup();
    const started = await api.recorder.start({ projectKey: 'SHOP' });
    expect(started.state).toBe('recording');
    const page = runtime.recorder.page(started.sessionId);
    await guestCheckout(page);

    const live = await api.recorder.status({ sessionId: started.sessionId });
    expect(live.steps.length).toBeGreaterThan(0);
    const stopped = await api.recorder.stop({ sessionId: started.sessionId });
    const draft = stopped.draft;
    expect(draft?.textSource).toBe('template');
    expect(draft?.steps.length).toBeGreaterThanOrEqual(4);
    expect(draft?.steps.length).toBeLessThanOrEqual(6);

    // Review: edit the text of the first step, keep the rest.
    const edited = (draft?.steps ?? []).map((s, i) => ({ id: s.id, action: i === 0 ? 'Search for the t-shirt' : s.action }));
    const saved = await api.recorder.save({ sessionId: started.sessionId, steps: edited, title: 'Recorded guest checkout' });
    expect(saved.learned).toBe(true);
    expect(saved.missingSecrets).toEqual([]);
    expect(saved.testCase).toMatchObject({ title: 'Recorded guest checkout', status: 'draft', tags: ['recorded'], version: 1 });
    expect(saved.testCase.steps[0]?.action).toBe('Search for the t-shirt');

    const script = await repos.learnedScripts.getFor(db, saved.testCase.id, environment.id);
    expect(script?.caseVersion).toBe(1);
    expect(script?.actions.length).toBeGreaterThan(edited.length);

    // The new case is listed with a learned script, and replay (no model) passes.
    const got = await api.cases.get({ key: saved.testCase.key });
    expect(got.learned[0]?.status).toBe('current');
    runtime.workers.start(1);
    const created = await api.runs.create({ projectKey: 'SHOP', caseKeys: [saved.testCase.key], environment: 'dev', mode: 'replay-only' });
    const run = await waitForRun(api, created.id);
    expect(run.status).toBe('passed');
    expect(modelCalls).toBe(0);
  });

  it('inserts steps into an existing case at fromStep and keeps its learned script aligned', async () => {
    const { api, runtime, db, environment } = await setup();
    const existing = await api.cases.create({
      projectKey: 'SHOP',
      title: 'Existing',
      priority: 'P2',
      type: 'e2e',
      status: 'draft',
      steps: [
        { action: 'Open the shop', assert: [], inputs: [] },
        { action: 'Finish', assert: [], inputs: [] },
      ],
    });
    const started = await api.recorder.start({ projectKey: 'SHOP', caseKey: existing.key, fromStep: 1 });
    // Recording into the middle starts paused so the user can reach the right page first.
    expect(started).toMatchObject({ state: 'paused', fromStep: 1, caseKey: existing.key });
    const page = runtime.recorder.page(started.sessionId);
    await api.recorder.resume({ sessionId: started.sessionId });
    await page.getByRole('searchbox', { name: 'Search products' }).fill('t-shirt');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.waitForURL(/search/);
    const stopped = await api.recorder.stop({ sessionId: started.sessionId });
    const saved = await api.recorder.save({ sessionId: started.sessionId, steps: (stopped.draft?.steps ?? []).map((s) => ({ id: s.id, action: s.action })) });
    expect(saved.testCase.version).toBe(2);
    expect(saved.testCase.steps.map((s) => s.action)).toEqual(['Open the shop', "Fill 'Search products' with search_products, click 'Search'", 'Finish']);
    const script = await repos.learnedScripts.getFor(db, existing.id, environment.id);
    expect([...new Set(script?.actions.map((a) => a.stepIndex))]).toEqual([1]);
    expect(script?.caseVersion).toBe(2);
  });

  it('never stores a typed password: it becomes a secret variable prompt', async () => {
    const { api, runtime, db, environment } = await setup();
    const started = await api.recorder.start({ projectKey: 'SHOP' });
    const page = runtime.recorder.page(started.sessionId);
    await page.goto(`${fixture.url}/shop/login`);
    await page.getByLabel('Email').fill('demo@example.com');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForLoadState('load');
    const stopped = await api.recorder.stop({ sessionId: started.sessionId });
    expect(JSON.stringify(stopped)).not.toContain(PASSWORD);
    expect(stopped.draft?.variables.find((v) => v.secret)).toEqual({ key: 'password', secret: true, field: 'Password' });

    const steps = (stopped.draft?.steps ?? []).map((s) => ({ id: s.id, action: s.action }));
    const withoutValue = await api.recorder.save({ sessionId: started.sessionId, steps });
    expect(withoutValue.missingSecrets).toEqual(['password']);
    expect(withoutValue.createdVariables).toContain('email');
    const everything = JSON.stringify([withoutValue, await repos.learnedScripts.listByCase(db, withoutValue.testCase.id), await repos.environments.get(db, environment.id)]);
    expect(everything).not.toContain(PASSWORD);
  });

  it('stores a secret value supplied in the review encrypted', async () => {
    const { api, runtime, db, environment } = await setup();
    const started = await api.recorder.start({ projectKey: 'SHOP' });
    const page = runtime.recorder.page(started.sessionId);
    await page.goto(`${fixture.url}/shop/login`);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.waitForLoadState('load');
    const stopped = await api.recorder.stop({ sessionId: started.sessionId });
    const steps = (stopped.draft?.steps ?? []).map((s) => ({ id: s.id, action: s.action }));
    const saved = await api.recorder.save({ sessionId: started.sessionId, steps, variables: { password: 'typed-in-review' } });
    expect(saved.missingSecrets).toEqual([]);
    const masked = await api.environments.get({ id: environment.id });
    expect(masked.variables.find((v) => v.key === 'password')).toMatchObject({ secret: true, masked: true });
    expect(JSON.stringify(masked)).not.toContain('typed-in-review');
    expect(await repos.environments.getSecret(db, environment.id, 'password')).toBe('typed-in-review');
  });

  it('refuses to record outside local mode and for unknown sessions', async () => {
    const { api } = await setup('team');
    await expect(api.recorder.start({ projectKey: 'SHOP' })).rejects.toMatchObject({ message: expect.stringContaining('local mode') });
    await expect(api.recorder.status({ sessionId: 'x'.repeat(21) })).rejects.toBeDefined();
  });

  it('cancel closes the browser and forgets the session', async () => {
    const { api } = await setup();
    const started = await api.recorder.start({ projectKey: 'SHOP' });
    await api.recorder.cancel({ sessionId: started.sessionId });
    await expect(api.recorder.status({ sessionId: started.sessionId })).rejects.toBeDefined();
  });
});
