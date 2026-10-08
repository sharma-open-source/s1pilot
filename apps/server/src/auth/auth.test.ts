import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault, openDb, repos, schema, type Db } from '@s1pilot/db';
import { createLogger } from '@s1pilot/domain/logger';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, mockResolver } from '@s1pilot/providers';
import { launchBrowser } from '@s1pilot/runner';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';
import type { ModelFactory } from '../worker/models.js';
import { createRuntime } from '../worker/runtime.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const makeCaller = createCallerFactory(appRouter);
const VALIDATION = { url: '/shop', assertion: { kind: 'text-visible' as const, value: 'Signed in as' } };

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

const modelFactory: ModelFactory = (settings) => ({
  // The scripted mock counts calls per step text, so each run gets a fresh one.
  s1: new MockDecisionModel({
    fallback: mockResolver({
      steps: { 'Log in as the demo customer': ['[link] Log in', '[textbox] Email', '[textbox] Password', '[button] Log in'] },
      inputs: { email: 'login_email', password: 'login_password' },
      expected: 0.95,
    }),
  }),
  thresholds: settings.thresholds,
  modelName: 'mock',
});

async function setup(password = 'password123') {
  const dataDir = mkdtempSync(join(tmpdir(), 's1p-auth-'));
  const db: Db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  const config = loadConfig({ dataDir, logLevel: 'silent', workers: 0 }, {});
  const log = createLogger({ level: 'silent' });
  const runtime = createRuntime({
    db,
    config,
    log,
    launchHeaded: () => launchBrowser('chromium'),
    workerOptions: { createModels: modelFactory, pollMs: 50 },
  });
  cleanups.push(async () => {
    await runtime.auth.close();
    await runtime.workers.stop();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const api = makeCaller(createContext({ db, config, log, runtime }));
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: `${fixture.url}/shop` });
  const [dev] = await repos.environments.listByProject(db, project.id);
  const env = dev as NonNullable<typeof dev>;
  await repos.environments.update(db, env.id, {
    variables: [
      { key: 'login_email', value: 'demo@example.com', secret: false, source: 'inline' },
      { key: 'login_password', value: password, secret: true, source: 'inline' },
    ],
  });
  await api.models.updateSettings({
    target: 'SHOP',
    settings: { system1: { adapter: 'mock', model: 'mock' }, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, dualOrderSensitive: false },
  });
  await api.sharedSteps.create({
    projectKey: 'SHOP',
    name: 'login-as-customer',
    steps: [{ action: 'Log in as the demo customer', inputs: ['login_email', 'login_password'], assert: [] }],
  });
  const tc = await api.cases.create({
    projectKey: 'SHOP',
    title: 'Customer starts logged in',
    priority: 'P1',
    type: 'smoke',
    status: 'ready',
    preconditions: [{ auth: 'login-as-customer' }],
    steps: [{ action: 'Look at the page header', assert: [{ type: 'elementVisible', text: 'Signed in as demo@example.com', visible: true }], inputs: [] }],
  });
  return { api, db, runtime, env, tc };
}

async function runCase(api: Awaited<ReturnType<typeof setup>>['api'], runtime: Awaited<ReturnType<typeof setup>>['runtime'], key: string) {
  runtime.workers.start(1);
  const created = await api.runs.create({ projectKey: 'SHOP', caseKeys: [key], environment: 'dev' });
  const start = Date.now();
  for (;;) {
    const run = await api.runs.get(created.id);
    if (['passed', 'failed', 'needs-review', 'cancelled', 'error'].includes(run.status)) return run;
    if (Date.now() - start > 90_000) throw new Error('run timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('auth tRPC + worker', () => {
  it('refreshes a flow login, stores the state encrypted and starts runs logged in', async () => {
    const { api, db, runtime, env, tc } = await setup();
    const flow = await api.auth.saveFlow({ environmentId: env.id, name: 'login-as-customer', flowId: 'login-as-customer', validation: VALIDATION });
    expect(flow).toMatchObject({ kind: 'flow', status: 'never', hasState: false });

    const refreshed = await api.auth.refresh({ id: flow.id });
    expect(refreshed).toMatchObject({ status: 'valid', hasState: true });
    expect(refreshed.lastRefreshedAt).toBeDefined();
    // Never returned to the client, never stored unencrypted.
    expect(JSON.stringify(await api.auth.list({ environmentId: env.id }))).not.toContain('fx_user');
    const row = db.orm.select().from(schema.authSetups).get();
    expect(row?.stateCiphertext?.startsWith('v1:')).toBe(true);
    expect(JSON.stringify(row)).not.toContain('fx_user');
    expect(await repos.authSetups.getState(db, flow.id)).toContain('fx_user');

    const run = await runCase(api, runtime, tc.key);
    expect(run.status).toBe('passed');
  });

  it('refreshes an expired state once when a run needs it, and blocks the case if that fails', async () => {
    const { api, db, runtime, env, tc } = await setup();
    const flow = await api.auth.saveFlow({ environmentId: env.id, name: 'login-as-customer', flowId: 'login-as-customer', validation: VALIDATION });
    await repos.authSetups.saveState(db, flow.id, JSON.stringify({ cookies: [], origins: [] }));
    const checked = await api.auth.validate({ id: flow.id });
    expect(checked.ok).toBe(false);
    expect(checked.setup.status).toBe('expired');

    const run = await runCase(api, runtime, tc.key);
    expect(run.status).toBe('passed');
    expect((await api.auth.list({ environmentId: env.id }))[0]?.status).toBe('valid');

    // The password changes: the stored state is rejected, the refresh fails, the case is blocked.
    await repos.authSetups.saveState(db, flow.id, JSON.stringify({ cookies: [], origins: [] }));
    await repos.environments.update(db, env.id, {
      variables: [
        { key: 'login_email', value: 'demo@example.com', secret: false, source: 'inline' },
        { key: 'login_password', value: 'changed', secret: true, source: 'inline' },
      ],
    });
    const blocked = await runCase(api, runtime, tc.key);
    expect(blocked.results[0]?.verdict).toBe('blocked');
    expect(blocked.status).not.toBe('passed');
  });

  it('records a login in a browser, saves it encrypted, validates and deletes it', async () => {
    const { api, db, runtime, env } = await setup();
    const started = await api.auth.record({ environmentId: env.id, name: 'recorded-login', validation: VALIDATION });
    expect(started).toMatchObject({ kind: 'recorded', recording: true });
    const page = runtime.auth.recordingPage(started.id);
    if (!page) throw new Error('no recording page');
    await page.goto(`${fixture.url}/shop/login`);
    await page.getByLabel('Email').fill('demo@example.com');
    await page.getByLabel('Password').fill('password123');
    await page.getByRole('button', { name: 'Log in' }).click();
    await page.getByText('Signed in as').waitFor();

    const saved = await api.auth.finishRecording({ id: started.id });
    expect(saved).toMatchObject({ status: 'valid', hasState: true });
    expect(runtime.auth.recordingPage(started.id)).toBeUndefined();
    expect(db.orm.select().from(schema.authSetups).get()?.stateCiphertext).not.toContain('fx_user');
    expect((await api.auth.validate({ id: started.id })).ok).toBe(true);
    await expect(api.auth.refresh({ id: started.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(await api.auth.delete({ id: started.id })).toMatchObject({ deleted: true });
    expect(await api.auth.list({ environmentId: env.id })).toEqual([]);
  });

  it('addresses setups by project key + name (wizard shape)', async () => {
    const { api, runtime } = await setup();
    const started = await api.auth.record({ projectKey: 'SHOP', name: 'login-as-customer' });
    const page = runtime.auth.recordingPage(started.id);
    await page?.goto(`${fixture.url}/shop/login`);
    await page?.getByLabel('Email').fill('demo@example.com');
    await page?.getByLabel('Password').fill('password123');
    await page?.getByRole('button', { name: 'Log in' }).click();
    await page?.getByText('Signed in as').waitFor();
    const saved = await api.auth.finishRecording({ projectKey: 'SHOP', name: 'login-as-customer' });
    expect(saved).toMatchObject({ id: started.id, status: 'valid' });
  });
});
