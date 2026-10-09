import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { newId, type Priority } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config.js';
import { registerExportRoutes } from '../exports/routes.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';
import type { ServerRuntime } from '../worker/runtime.js';

import { evaluateExitCriteria } from './evaluate.js';

const makeCaller = createCallerFactory(appRouter);
const dbs: Db[] = [];
afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
});

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const config = loadConfig({ dataDir: '/tmp/s1pilot-test-nonexistent/.s1pilot', logLevel: 'silent' }, {});
  const api = makeCaller(createContext({ db, config, log: createLogger({ level: 'silent' }) }));
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  const env = await repos.environments.create(db, { id: newId(), projectId: project.id, name: 'staging', baseUrl: 'http://a.test' });
  const plan = await api.plans.create({
    projectKey: 'SHOP',
    name: 'Release',
    selection: { kind: 'list', caseIds: [] },
    matrix: [{ environmentId: env.id, browser: 'chromium' }],
    exitCriteria: [
      { kind: 'p0-passed', params: { percent: 100 } },
      { kind: 'pass-rate', params: { percent: 95, priorities: ['P1', 'P2'] } },
      { kind: 'no-open-defects', params: { severity: 'S2' } },
      { kind: 'review-queue-empty', params: {} },
    ],
  });
  await repos.runs.create(db, {
    id: 'r1',
    projectId: project.id,
    planId: plan.id,
    trigger: 'manual',
    status: 'needs-review',
    startedAt: '2026-10-08T10:00:00.000Z',
    finishedAt: '2026-10-08T10:01:00.000Z',
    summary: { passed: 1, failed: 1, blocked: 0, skipped: 0, flaky: 0, needsReview: 1 },
  });
  const add = async (n: number, priority: Priority, verdict: 'passed' | 'failed' | 'needs-review') => {
    const c = await api.cases.create({ projectKey: 'SHOP', title: `Case ${n}`, priority, steps: [{ action: 'Open' }] });
    await repos.results.createCase(db, { id: `cr${n}`, runId: 'r1', caseId: c.id, caseVersion: 1, environmentId: env.id, verdict, durationMs: 5, mode: 'explore', browser: 'chromium' });
    await repos.results.addStep(db, { id: `cr${n}-0`, caseResultId: `cr${n}`, stepIndex: 0, status: verdict === 'failed' ? 'failed' : 'passed' });
  };
  await add(1, 'P0', 'failed');
  await add(2, 'P1', 'passed');
  await add(3, 'P3', 'needs-review');
  await repos.reviews.create(db, { id: 'rv1', projectId: project.id, kind: 'verdict', refId: 'cr3', status: 'pending' });
  return { api, db, project, plan };
}

describe('exit criteria on a run', () => {
  it('reproduces the "2 of 4 not met" state and re-evaluates when a review is approved', async () => {
    const { api, db } = await setup();
    const before = await api.runs.report('r1');
    expect(before.exitCriteria).toMatchObject({ met: 2, total: 4, allMet: false });
    expect(before.exitCriteria?.items.map((i) => [i.label, i.met])).toEqual([
      ['≥ 100% of P0 passed', false],
      ['≥ 95% of P1/P2 passed', true],
      ['No open defects ≥ S2', true],
      ['Review queue empty', false],
    ]);
    await api.reviews.decide({ id: 'rv1', decision: 'approve', note: '' });
    const after = await api.runs.report('r1');
    expect(after.exitCriteria).toMatchObject({ met: 3, total: 4 });
    const run = await repos.runs.get(db, 'r1');
    const plan = await repos.plans.get(db, run?.planId ?? '');
    if (!run) throw new Error('run missing');
    expect((await evaluateExitCriteria(run, plan, db)).met).toBe(false);
  });

  it('counts open defects of the severity or worse and records a sign-off', async () => {
    const { api } = await setup();
    await api.defects.create({ projectKey: 'SHOP', title: 'Checkout broken', severity: 'S1', resultIds: [] });
    expect((await api.runs.report('r1')).exitCriteria?.items[2]).toMatchObject({ met: false, actual: '1 open' });
    await api.defects.create({ projectKey: 'SHOP', title: 'Typo', severity: 'S4', resultIds: [] });
    expect((await api.runs.report('r1')).exitCriteria?.items[2]?.actual).toBe('1 open');

    expect((await api.runs.report('r1')).signOff).toBeNull();
    await api.runs.signOff({ runId: 'r1', note: 'Ship it' });
    expect((await api.runs.report('r1')).signOff).toMatchObject({ by: 'local', note: 'Ship it', criteriaMet: false });
  });

  it('serves a PDF summary with the criteria table', async () => {
    const { db } = await setup();
    const app = Fastify();
    const runtime = { queue: { listByRun: async () => [] } } as unknown as ServerRuntime;
    registerExportRoutes(app, { db, runtime, config: { artifactsDir: '/tmp/s1pilot-test-nonexistent/artifacts' } });
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/export.pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(2000);
    expect((await app.inject({ method: 'GET', url: '/api/runs/nope/export.pdf' })).statusCode).toBe(404);
    await app.close();
  }, 60_000);
});
