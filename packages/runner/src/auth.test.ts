import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuthSetupSchema,
  EnvironmentSchema,
  SharedStepSchema,
  TestCaseSchema,
  createRedactor,
  newId,
  type AuthSetup,
  type Environment,
  type TestCase,
} from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, mockResolver } from '@s1pilot/providers';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createAuthStateProvider,
  createFlowRefresher,
  startLoginRecording,
  validateAuthState,
  type AuthSetupStore,
  type StorageState,
} from './auth.js';
import { runCases, type RunCasesInput } from './run-cases.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let server: FixtureServer;
let browser: Browser;
beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await server.close();
});

const tmp = (): string => mkdtempSync(join(tmpdir(), 's1p-auth-'));
const EMPTY_STATE: StorageState = { cookies: [], origins: [] };
const VALIDATION = { url: '/shop', assertion: { kind: 'text-visible' as const, value: 'Signed in as' } };

const env = (): Environment => EnvironmentSchema.parse({ id: newId(), projectId: newId(), name: 'local', baseUrl: `${server.url}/shop` });

const LOGIN_FLOW = SharedStepSchema.parse({
  id: newId(),
  projectId: newId(),
  name: 'login-as-customer',
  steps: [{ action: 'Log in as the demo customer', inputs: ['login_email', 'login_password'] }],
});

/** The scripted mock keeps per-step call counters, so every run gets its own. */
const makeMock = (): MockDecisionModel =>
  new MockDecisionModel({
  fallback: mockResolver({
    steps: { 'Log in as the demo customer': ['[link] Log in', '[textbox] Email', '[textbox] Password', '[button] Log in'] },
    inputs: { email: 'login_email', password: 'login_password' },
    expected: 0.95,
  }),
});

function vars(password: string): RunCasesInput['vars'] {
  const values: Record<string, string> = { login_email: 'demo@example.com', login_password: password };
  return { keys: () => Object.keys(values), isSecret: (k) => k === 'login_password', secretValues: () => [password], get: (k) => values[k] };
}

function refresher(password = 'password123') {
  return createFlowRefresher({
    browser,
    models: { s1: makeMock(), thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, modelName: 'mock' },
    vars: vars(password),
    redactor: createRedactor({ secrets: [password], patterns: [] }),
    flows: (id) => (id === LOGIN_FLOW.name || id === LOGIN_FLOW.id ? LOGIN_FLOW : undefined),
    out: tmp(),
  });
}

/** In-memory store; the state is held in a field (the server encrypts it in the database). */
function memoryStore(environment: Environment, initial?: Partial<AuthSetup> & { state?: StorageState }) {
  let setup: AuthSetup = AuthSetupSchema.parse({
    id: newId(),
    environmentId: environment.id,
    name: 'login-as-customer',
    kind: 'flow',
    flowId: LOGIN_FLOW.name,
    validation: VALIDATION,
    ...initial,
  });
  let state = initial?.state;
  const calls = { saved: 0, expired: 0 };
  const store: AuthSetupStore = {
    find: async (_e, name) => (name === setup.name ? setup : undefined),
    loadState: async () => state,
    saveState: async (_s, next) => {
      state = next;
      calls.saved++;
      setup = { ...setup, status: 'valid', hasState: true };
    },
    markExpired: async () => {
      calls.expired++;
      setup = { ...setup, status: 'expired' };
    },
  };
  return { store, calls, current: () => setup, state: () => state };
}

function loggedInCase(): TestCase {
  return TestCaseSchema.parse({
    id: newId(),
    projectId: newId(),
    key: 'SHOP-TC-1',
    title: 'Customer starts logged in',
    priority: 'P1',
    type: 'smoke',
    status: 'ready',
    preconditions: [{ auth: 'login-as-customer' }],
    steps: [
      {
        action: 'Look at the page header',
        assert: [{ type: 'elementVisible', text: 'Signed in as demo@example.com' }],
      },
    ],
  });
}

function runWith(environment: Environment, store: AuthSetupStore, password = 'password123', cases = [loggedInCase()]) {
  const refresh = refresher(password);
  return runCases({
    cases,
    environment,
    browser,
    browserName: 'chromium',
    models: { s1: makeMock(), thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, modelName: 'mock' },
    out: tmp(),
    vars: vars(password),
    redactor: createRedactor({ secrets: [password], patterns: [] }),
    auth: createAuthStateProvider({ browser, store, refresh }),
  });
}

describe('auth setup flows', () => {
  it('refreshes the fixture login flow into a valid state and a case with auth: starts logged in', async () => {
    const environment = env();
    const { store, calls, current, state } = memoryStore(environment);
    const report = await runWith(environment, store);
    expect(report.cases[0]?.verdict).toBe('passed');
    expect(calls.saved).toBe(1);
    expect(current().status).toBe('valid');
    expect(state()?.cookies.some((c) => c.name === 'fx_user')).toBe(true);
    // The state authenticates a fresh context.
    expect((await validateAuthState(browser, environment, state() as StorageState, VALIDATION)).ok).toBe(true);
    // The case without auth is anonymous.
    const anonymous = await validateAuthState(browser, environment, EMPTY_STATE, VALIDATION);
    expect(anonymous.ok).toBe(false);
  });

  it('reuses a valid stored state without refreshing', async () => {
    const environment = env();
    const first = memoryStore(environment);
    await runWith(environment, first.store);
    const second = memoryStore(environment, { state: first.state() as StorageState });
    const report = await runWith(environment, second.store);
    expect(report.cases[0]?.verdict).toBe('passed');
    expect(second.calls).toEqual({ saved: 0, expired: 0 });
  });

  it('refreshes an expired state exactly once, even for concurrent cases', async () => {
    const environment = env();
    const { store, calls } = memoryStore(environment, { state: EMPTY_STATE, status: 'valid', hasState: true });
    const two = [loggedInCase(), { ...loggedInCase(), key: 'SHOP-TC-2', id: newId() }];
    const report = await runWith(environment, store, 'password123', two);
    expect(report.cases.map((c) => c.verdict)).toEqual(['passed', 'passed']);
    expect(calls).toEqual({ saved: 1, expired: 1 });
  });

  it('blocks the case when the refresh keeps failing (one attempt only)', async () => {
    const environment = env();
    const { store, calls, current } = memoryStore(environment);
    const two = [loggedInCase(), { ...loggedInCase(), key: 'SHOP-TC-2', id: newId() }];
    const report = await runWith(environment, store, 'wrong-password', two);
    expect(report.cases.map((c) => c.verdict)).toEqual(['blocked', 'blocked']);
    expect(report.cases[0]?.steps[0]?.reason).toMatch(/auth: Login .*login-as-customer/);
    expect(calls.saved).toBe(0);
    expect(current().status).not.toBe('valid');
  });

  it('blocks when the auth setup does not exist or a recorded login is expired', async () => {
    const environment = env();
    const missing = memoryStore(environment, { name: 'someone-else' });
    const a = await runWith(environment, missing.store);
    expect(a.cases[0]?.verdict).toBe('blocked');
    expect(a.cases[0]?.steps[0]?.reason).toContain('not found');

    const recorded = memoryStore(environment, { kind: 'recorded', flowId: undefined, state: EMPTY_STATE });
    const b = await runWith(environment, recorded.store);
    expect(b.cases[0]?.verdict).toBe('blocked');
    expect(b.cases[0]?.steps[0]?.reason).toContain('expired');
    expect(recorded.calls.expired).toBe(1);
  });

  it('records a login in a browser and returns its state', async () => {
    const environment = env();
    const recording = await startLoginRecording(environment, { launch: () => chromium.launch() });
    await recording.page.goto(`${server.url}/shop/login`);
    await recording.page.getByLabel('Email').fill('demo@example.com');
    await recording.page.getByLabel('Password').fill('password123');
    await recording.page.getByRole('button', { name: 'Log in' }).click();
    await recording.page.getByText('Signed in as').waitFor();
    const state = await recording.finish();
    expect((await validateAuthState(browser, environment, state, VALIDATION)).ok).toBe(true);
  });
});
