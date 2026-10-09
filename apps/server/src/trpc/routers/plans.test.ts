import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import { createContext } from '../context.js';
import { appRouter, createCallerFactory } from '../router.js';

const makeCaller = createCallerFactory(appRouter);
const dbs: Db[] = [];

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const ctx = createContext({
    db,
    config: loadConfig({ dataDir: '/tmp/s1pilot-test-nonexistent/.s1pilot' }, {}),
    log: createLogger({ level: 'silent' }),
  });
  const api = makeCaller(ctx);
  await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  const envs = await api.environments.list({ projectKey: 'SHOP' });
  const dev = envs[0] as { id: string };
  const prod = await api.environments.create({
    projectKey: 'SHOP',
    name: 'prod',
    baseUrl: 'http://prod.test',
    readOnly: true,
    browsers: [{ browser: 'chromium' }],
  });
  return { api, db, dev, prod };
}

afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
});

const steps = [{ action: 'Open the shop' }];
const mk = (api: Awaited<ReturnType<typeof setup>>['api'], over: Record<string, unknown> = {}) =>
  api.cases.create({ projectKey: 'SHOP', title: 'A case', steps, ...over });

interface JobPayload {
  environmentId: string;
  browser: string;
  mode: string;
  retries?: number;
  parallelism?: number;
  checks?: { a11y?: boolean };
}

function jobPayloads(db: Db, runId: string): JobPayload[] {
  const rows = db.sqlite.prepare('select payload from jobs where run_id = ?').all(runId) as { payload: string }[];
  return rows.map((r) => JSON.parse(r.payload) as JobPayload);
}

describe('plans router', () => {
  it('creates, lists, updates and deletes plans', async () => {
    const { api, dev } = await setup();
    const plan = await api.plans.create({
      projectKey: 'SHOP',
      name: 'Smoke',
      selection: { kind: 'query', query: 'tags:smoke OR priority<=P0' },
      matrix: [{ environmentId: dev.id, browser: 'chromium' }],
    });
    expect(plan).toMatchObject({ name: 'Smoke', retries: 0, parallelism: 1, mode: 'replay-heal' });
    const list = await api.plans.list({ projectKey: 'SHOP' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: plan.id, lastRun: null });

    const updated = await api.plans.update({ id: plan.id, patch: { retries: 2, name: 'Smoke 2' } });
    expect(updated).toMatchObject({ retries: 2, name: 'Smoke 2' });
    expect((await api.plans.get(plan.id)).name).toBe('Smoke 2');

    await expect(
      api.plans.create({ projectKey: 'SHOP', name: 'smoke 2', selection: { kind: 'list', caseIds: [] }, matrix: [{ environmentId: dev.id, browser: 'chromium' }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      api.plans.create({ projectKey: 'SHOP', name: 'Bad', selection: { kind: 'query', query: 'priority<=P9' }, matrix: [{ environmentId: dev.id, browser: 'chromium' }] }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      api.plans.create({ projectKey: 'SHOP', name: 'Bad env', selection: { kind: 'list', caseIds: [] }, matrix: [{ environmentId: 'nope', browser: 'chromium' }] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await api.plans.delete(plan.id);
    expect(await api.plans.list({ projectKey: 'SHOP' })).toEqual([]);
    await expect(api.plans.get(plan.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports query syntax errors with a position', async () => {
    const { api, dev } = await setup();
    await expect(
      api.plans.preview({ projectKey: 'SHOP', name: 'x', selection: { kind: 'query', query: 'tags:a AND (b' }, matrix: [{ environmentId: dev.id, browser: 'chromium' }] }),
    ).rejects.toThrow(/position 11/);
  });

  it('previews a query plan and the created run matches the preview', async () => {
    const { api, db, dev, prod } = await setup();
    const checkout = await api.suites.create({ projectKey: 'SHOP', name: 'Checkout' });
    const a = await mk(api, { title: 'a', suiteId: checkout.id, priority: 'P1', status: 'ready' });
    await mk(api, { title: 'b', suiteId: checkout.id, priority: 'P2', status: 'ready', parameters: [{ x: 1 }, { x: 2 }, { x: 3 }] });
    await mk(api, { title: 'c', suiteId: checkout.id, priority: 'P3', status: 'ready' });
    await mk(api, { title: 'd', priority: 'P0', status: 'ready' });
    // a learned script for `a` in dev and prod
    const run0 = await repos.runs.create(db, { id: newId(), projectId: a.projectId, trigger: 'manual', status: 'passed' });
    for (const env of [dev, prod]) {
      await repos.learnedScripts.upsert(db, { id: newId(), caseId: a.id, caseVersion: 1, environmentId: env.id, createdFromRunId: run0.id, actions: [] });
    }

    const draft = {
      projectKey: 'SHOP',
      name: 'Checkout release',
      selection: { kind: 'query' as const, query: 'suite:Checkout AND priority<=P2 AND status:ready' },
      matrix: [
        { environmentId: dev.id, browser: 'chromium' as const },
        { environmentId: dev.id, browser: 'firefox' as const },
        { environmentId: prod.id, browser: 'chromium' as const },
      ],
      mode: 'replay-heal' as const,
      retries: 1,
      parallelism: 2,
      checks: { a11y: true },
    };
    const preview = await api.plans.preview(draft);
    // 2 cases x 3 combos = 6 jobs; case b has 3 parameter rows => (1 + 3) x 3 = 12 executions.
    expect(preview).toMatchObject({ matched: 2, learned: 1, notLearned: 1, quarantined: 0, jobs: 6, executions: 12 });
    expect(preview.estimateMin).toBeGreaterThan(0);

    const plan = await api.plans.create(draft);
    const run = await api.runs.create({ projectKey: 'SHOP', planId: plan.id, buildRef: 'abc' });
    expect(run.planId).toBe(plan.id);
    expect((await api.runs.get(run.id)).progress.total).toBe(preview.jobs);
    const jobs = jobPayloads(db, run.id);
    expect(jobs).toHaveLength(preview.jobs);
    expect(jobs.filter((j) => j.environmentId === prod.id && j.browser === 'chromium')).toHaveLength(2);
    expect(jobs.every((j) => j.retries === 1 && j.parallelism === 2 && j.checks?.a11y === true && j.mode === 'replay-heal')).toBe(true);
    expect((await api.plans.get(plan.id)).lastRun).toMatchObject({ id: run.id });
  });

  it('respects read-only environments: only allowed browsers', async () => {
    const { api, dev, prod } = await setup();
    await mk(api, { title: 'a' });
    const draft = {
      projectKey: 'SHOP',
      name: 'Prod',
      selection: { kind: 'query' as const, query: 'a' },
      matrix: [
        { environmentId: prod.id, browser: 'chromium' as const },
        { environmentId: dev.id, browser: 'webkit' as const },
      ],
    };
    // Allowed on save: prod/chromium is listed, dev is not read-only.
    const plan = await api.plans.create(draft);
    // Firefox on prod is refused on save...
    await expect(
      api.plans.update({ id: plan.id, patch: { matrix: [{ environmentId: prod.id, browser: 'firefox' }] } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // ...and skipped (with a reason) in a preview of a draft that contains it.
    const preview = await api.plans.preview({ ...draft, matrix: [...draft.matrix, { environmentId: prod.id, browser: 'firefox' }] });
    expect(preview.jobs).toBe(2);
    expect(preview.skippedCombos).toMatchObject([{ environmentId: prod.id, browser: 'firefox' }]);
    // A run from a plan whose environment later became stricter skips the same combos.
    await api.environments.update({ id: prod.id, patch: { browsers: [{ browser: 'firefox' }] } });
    const run = await api.runs.create({ projectKey: 'SHOP', planId: plan.id });
    expect((await api.runs.get(run.id)).progress.total).toBe(1);
  });

  it('runs.create still needs caseKeys and environment without a plan', async () => {
    const { api } = await setup();
    await expect(api.runs.create({ projectKey: 'SHOP' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
