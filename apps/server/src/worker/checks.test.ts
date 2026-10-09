import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import type { DecisionModel } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, mockResolver } from '@s1pilot/providers';
import { launchBrowser } from '@s1pilot/runner';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';

import type { ModelFactory } from './models.js';
import { createRuntime } from './runtime.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const makeCaller = createCallerFactory(appRouter);
const STEP = 'Look at the newsletter page';

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

const factory: ModelFactory = (settings) => {
  const mock = new MockDecisionModel({ fallback: mockResolver({ steps: { [STEP]: [] }, inputs: {}, expected: 0.95 }) });
  const s1: DecisionModel = { capabilities: mock.capabilities, decide: (req) => mock.decide(req) };
  return { s1, thresholds: settings.thresholds, modelName: 'mock' };
};

async function setup(query: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 's1p-checks-'));
  const db: Db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  const config = loadConfig({ dataDir, logLevel: 'silent', workers: 0 }, {});
  const log = createLogger({ level: 'silent' });
  const runtime = createRuntime({ db, config, log, workerOptions: { createModels: factory, pollMs: 50, launch: () => launchBrowser('chromium') } });
  cleanups.push(async () => {
    await runtime.workers.stop();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const api = makeCaller(createContext({ db, config, log, runtime }));
  const project = await api.projects.create({ name: 'Quality', key: 'QA', baseUrl: `${fixture.url}/quality${query}` });
  const [env] = await repos.environments.listByProject(db, project.id);
  if (!env) throw new Error('no default environment');
  await api.models.updateSettings({
    target: 'QA',
    settings: { system1: { adapter: 'mock', model: 'mock' }, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, dualOrderSensitive: false },
  });
  const tc = await api.cases.create({
    projectKey: 'QA',
    title: 'Newsletter page',
    priority: 'P2',
    type: 'e2e',
    status: 'ready',
    steps: [{ action: STEP, expected: 'The newsletter form is shown' }],
  });
  return { api, db, runtime, tc, env };
}

type Api = Awaited<ReturnType<typeof setup>>['api'];

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 120_000): Promise<T> {
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

async function runPlan(query: string, checks: Record<string, unknown>) {
  const s = await setup(query);
  const plan = await s.api.plans.create({
    projectKey: 'QA',
    name: 'Quality',
    selection: { kind: 'list', caseIds: [s.tc.id] },
    matrix: [{ environmentId: s.env.id, browser: 'chromium' }],
    mode: 'explore',
    checks: { a11y: false, consoleErrors: false, visual: false, video: false, ...checks },
  });
  s.runtime.workers.start(1);
  const run = await finished(s.api, (await s.api.runs.create({ projectKey: 'QA', planId: plan.id })).id);
  return { ...s, run, result: run.results[0] };
}

describe('plan checks', () => {
  it('an accessibility violation (missing label) fails the case, is stored as evidence and listed in the result detail', async () => {
    const { api, run, result } = await runPlan('?label=missing', { a11y: true });
    expect(run.status).toBe('failed');
    expect(result?.verdict).toBe('failed');
    const detail = await api.results.get(result?.id ?? '');
    const a11y = detail.checks.find((c) => c.kind === 'a11y');
    expect(a11y?.severity).toBe('fail');
    expect(a11y?.items.map((i) => i.ruleId)).toContain('label');
    expect(detail.result.checks?.find((c) => c.kind === 'a11y')).toMatchObject({ severity: 'fail' });
    const report = await api.runs.report(run.id);
    expect(report.results[0]?.checks.find((c) => c.kind === 'a11y')?.severity).toBe('fail');
    expect(report.results[0]?.note).toContain('checks failed: a11y');

    // "Create defect" drafts it as coming from the accessibility scan (S-054 source kind).
    const draft = await api.defects.createFromResult({ resultId: result?.id ?? '' });
    expect(draft.details.sourceKind).toBe('a11y');
    expect(draft.details.sourceLabel).toBe('accessibility scan');
    expect(draft.title).toContain('Accessibility');
  });

  it('console errors fail the case with "fail on console errors" and only warn without it', async () => {
    const off = await runPlan('?console=error', { consoleErrors: false });
    expect(off.run.status).toBe('passed');
    const warn = (await off.api.results.get(off.result?.id ?? '')).checks.find((c) => c.kind === 'console');
    expect(warn?.severity).toBe('warn');
    expect(warn?.items.length).toBeGreaterThan(0);
    expect((await off.api.runs.report(off.run.id)).results[0]?.checks.some((c) => c.severity === 'warn')).toBe(true);

    const on = await runPlan('?console=error', { consoleErrors: true });
    expect(on.run.status).toBe('failed');
    expect((await on.api.results.get(on.result?.id ?? '')).checks.find((c) => c.kind === 'console')?.severity).toBe('fail');
  });
});
