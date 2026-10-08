import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createContext } from '../context.js';
import { appRouter, createCallerFactory } from '../router.js';

const makeCaller = createCallerFactory(appRouter);
const dbs: Db[] = [];
afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
});

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const config = loadConfig({ dataDir: '/tmp/s1pilot-test-nonexistent/.s1pilot', logLevel: 'silent' }, {});
  const ctx = createContext({ db, config, log: createLogger({ level: 'silent' }) });
  const api = makeCaller(ctx);
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  const c = await api.cases.create({
    projectKey: 'SHOP',
    title: 'Invalid ZIP shows a field error',
    steps: [{ action: 'Open' }, { action: 'Enter ZIP', expected: 'An error appears next to the ZIP field' }, { action: 'Pay' }],
  });
  await repos.runs.create(db, {
    id: 'r1',
    projectId: project.id,
    trigger: 'manual',
    status: 'failed',
    startedAt: '2026-10-08T10:00:00.000Z',
    finishedAt: '2026-10-08T10:01:00.000Z',
    summary: { passed: 1, failed: 1, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 },
  });
  const add = async (id: string, verdict: 'passed' | 'failed') => {
    await repos.results.createCase(db, { id, runId: 'r1', caseId: c.id, caseVersion: 1, verdict, durationMs: 5, mode: 'explore', browser: 'webkit' });
    await repos.results.addStep(db, { id: `${id}-0`, caseResultId: id, stepIndex: 0, status: 'passed' });
    await repos.results.addStep(db, {
      id: `${id}-1`,
      caseResultId: id,
      stepIndex: 1,
      status: verdict === 'failed' ? 'failed' : 'passed',
      assertions: [{ assertion: 'ai', verdict: verdict === 'failed' ? 'fail' : 'pass', probability: 0.07 }],
    });
  };
  await add('cr1', 'passed');
  await add('cr2', 'failed');
  return { api, db, config, ctx };
}

describe('runs.report / results.get / results.overrideVerdict', () => {
  it('reports summary and result rows with the failed step', async () => {
    const { api } = await setup();
    const report = await api.runs.report('r1');
    expect(report.projectKey).toBe('SHOP');
    expect(report.exitCriteria).toBeNull();
    expect(report.run.summary).toMatchObject({ passed: 1, failed: 1 });
    const failed = report.results.find((r) => r.id === 'cr2');
    expect(failed).toMatchObject({ key: 'SHOP-TC-1', verdict: 'failed', browser: 'webkit', failedStep: 2 });
    await expect(api.runs.report('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns result detail with the case step text and expected', async () => {
    const { api } = await setup();
    const d = await api.results.get('cr2');
    expect(d.failedStep).toBe(2);
    expect(d.steps[1]).toMatchObject({ action: 'Enter ZIP', expected: 'An error appears next to the ZIP field', status: 'failed' });
    expect(d.notRun.map((s) => s.index)).toEqual([2]);
    expect(d.video).toBeNull();
    expect(d.console).toEqual([]);
  });

  it('override updates the counts and records a review item', async () => {
    const { api, db } = await setup();
    const out = await api.results.overrideVerdict({ resultId: 'cr2', verdict: 'passed', note: 'Known data issue' });
    expect(out.summary).toMatchObject({ passed: 2, failed: 0 });
    expect((await api.runs.report('r1')).run.summary).toMatchObject({ passed: 2, failed: 0 });
    const project = await repos.projects.getByKey(db, 'SHOP');
    const items = await repos.reviews.list(db, { projectId: (project as { id: string }).id, kind: 'verdict' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ refId: 'cr2' });
    expect(items[0]?.note).toContain('failed -> passed');
    expect((await api.results.get('cr2')).overrides).toHaveLength(1);
    await expect(api.results.overrideVerdict({ resultId: 'cr2', verdict: 'passed', note: '' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

describe('export endpoint', () => {
  it('renders JUnit, JSON and HTML for a run and rejects unknown formats', async () => {
    const { db, config } = await setup();
    const app = await buildApp(config, { db, dev: true, workers: 0 });
    try {
      const junit = await app.inject({ url: '/api/runs/r1/export/junit' });
      expect(junit.statusCode).toBe(200);
      expect(junit.headers['content-disposition']).toContain('attachment');
      expect(junit.body).toContain('<testsuites');
      const json = await app.inject({ url: '/api/runs/r1/export/json' });
      expect(JSON.parse(json.body)).toMatchObject({ runId: 'r1', totals: { passed: 1, failed: 1 } });
      const html = await app.inject({ url: '/api/runs/r1/export/html' });
      expect(html.body).toContain('SHOP-TC-1');
      expect((await app.inject({ url: '/api/runs/r1/export/pdf' })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/runs/zzz/export/json' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
