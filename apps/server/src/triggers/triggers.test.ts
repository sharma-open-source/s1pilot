import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createContext } from '../trpc/context.js';
import { appRouter, createCallerFactory } from '../trpc/router.js';

import { PlanScheduler } from './scheduler.js';

const makeCaller = createCallerFactory(appRouter);
const log = createLogger({ level: 'silent' });
const dbs: Db[] = [];
const dirs: string[] = [];
const closers: Array<() => Promise<unknown>> = [];

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const dir = mkdtempSync(join(tmpdir(), 's1pilot-triggers-'));
  dirs.push(dir);
  const config = loadConfig({ dataDir: join(dir, '.s1pilot') }, {});
  const api = makeCaller(createContext({ db, config, log }));
  await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  const dev = (await api.environments.list({ projectKey: 'SHOP' }))[0] as { id: string };
  const testCase = await api.cases.create({ projectKey: 'SHOP', title: 'A case', steps: [{ action: 'Open the shop' }], status: 'ready' });
  const mkPlan = (over: Record<string, unknown> = {}) =>
    api.plans.create({
      projectKey: 'SHOP',
      name: `Plan ${Math.random()}`,
      selection: { kind: 'list', caseIds: [testCase.id] },
      matrix: [{ environmentId: dev.id, browser: 'chromium' }],
      ...over,
    });
  return { db, api, config, mkPlan, dev };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const c of closers.splice(0)) await c();
  dbs.splice(0).forEach((d) => d.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

describe('scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  it('fires "0 2 * * 1-5" on weekdays at 02:00 only', async () => {
    vi.setSystemTime(new Date('2026-10-09T00:00:00Z')); // Friday
    const { db, api, mkPlan } = await setup();
    const plan = await mkPlan({ schedule: '0 2 * * 1-5' });
    await api.triggers.update({ planId: plan.id, timezone: 'UTC' });
    const fired: string[] = [];
    const scheduler = new PlanScheduler({ db, log });
    await scheduler.start(async () => {
      fired.push(new Date().toISOString());
    });
    expect(scheduler.size).toBe(1);
    await vi.advanceTimersByTimeAsync(8 * 24 * 3600 * 1000); // through Saturday 2026-10-17 00:00
    scheduler.stop();
    expect(fired).toEqual([
      '2026-10-09T02:00:00.000Z',
      '2026-10-12T02:00:00.000Z',
      '2026-10-13T02:00:00.000Z',
      '2026-10-14T02:00:00.000Z',
      '2026-10-15T02:00:00.000Z',
      '2026-10-16T02:00:00.000Z',
    ]);
  }, 30_000);

  it('honours the plan timezone and treats an empty schedule as off', async () => {
    vi.setSystemTime(new Date('2026-10-11T23:00:00Z'));
    const { db, api, mkPlan } = await setup();
    const tokyo = await mkPlan({ schedule: '0 9 * * *' });
    await api.triggers.update({ planId: tokyo.id, timezone: 'Asia/Tokyo' });
    await mkPlan({ schedule: '' });
    const fired: string[] = [];
    const scheduler = new PlanScheduler({ db, log });
    await scheduler.start(async (id) => {
      fired.push(`${id}@${new Date().toISOString()}`);
    });
    expect(scheduler.size).toBe(1);
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000);
    scheduler.stop();
    expect(fired).toEqual([`${tokyo.id}@2026-10-12T00:00:00.000Z`]);
  });

  it('applies the overlap policy', async () => {
    vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
    const { db, api, mkPlan } = await setup();
    const plan = await mkPlan({ schedule: '0 2 * * *' });
    const project = await repos.projects.getByKey(db, 'SHOP');
    if (!project) throw new Error('no project');
    await repos.runs.create(db, { id: newId(), projectId: project.id, planId: plan.id, trigger: 'schedule', status: 'running' });
    let count = 0;
    const scheduler = new PlanScheduler({ db, log });
    await scheduler.start(async () => {
      count += 1;
    });
    expect(await scheduler.trigger(plan.id)).toBe(false);
    expect(count).toBe(0);
    await api.triggers.update({ planId: plan.id, skipIfRunning: false });
    expect(await scheduler.trigger(plan.id)).toBe(true);
    expect(count).toBe(1);
    // a finished previous run does not block
    await api.triggers.update({ planId: plan.id, skipIfRunning: true });
    for (const r of await repos.runs.listByPlan(db, plan.id)) await repos.runs.update(db, r.id, { status: 'passed' });
    expect(await scheduler.trigger(plan.id)).toBe(true);
    scheduler.stop();
  });

  it('reloads on plan change and lists upcoming runs', async () => {
    vi.setSystemTime(new Date('2026-10-09T10:00:00Z'));
    const { db, api, mkPlan } = await setup();
    const scheduler = new PlanScheduler({ db, log });
    await scheduler.start(async () => undefined);
    const plan = await mkPlan({ schedule: '0 2 * * *' });
    await api.triggers.update({ planId: plan.id, timezone: 'UTC' });
    await scheduler.reload(plan.id);
    expect(scheduler.size).toBe(1);
    await repos.plans.update(db, plan.id, { schedule: '' });
    await scheduler.reload(plan.id);
    expect(scheduler.size).toBe(0);
    scheduler.stop();

    await repos.plans.update(db, plan.id, { schedule: '0 2 * * *' });
    const upcoming = await api.triggers.upcoming('SHOP');
    expect(upcoming).toHaveLength(10);
    expect(upcoming[0]).toMatchObject({ planId: plan.id, at: '2026-10-10T02:00:00.000Z' });
    expect(upcoming[1]?.at).toBe('2026-10-11T02:00:00.000Z');
  });

  it('rejects invalid cron expressions and timezones', async () => {
    const { api, mkPlan } = await setup();
    await expect(mkPlan({ schedule: 'not a cron' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const plan = await mkPlan();
    await expect(api.triggers.update({ planId: plan.id, timezone: 'Mars/Base' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('webhook', () => {
  async function appWith() {
    const s = await setup();
    const app = await buildApp(s.config, { db: s.db, workers: 0, dev: true, scheduler: false });
    closers.push(() => app.close());
    return { ...s, app };
  }

  it('returns 404 for a wrong token or unknown plan, 202 with a run id for the right one', async () => {
    const { app, api, mkPlan, db } = await appWith();
    const plan = await mkPlan();
    const { token, webhookPath } = await api.triggers.get(plan.id);
    expect(webhookPath).toBe(`/api/hooks/plans/${plan.id}/${token}`);

    expect((await app.inject({ method: 'POST', url: `/api/hooks/plans/${plan.id}/wrong-token` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/hooks/plans/nope/${token}` })).statusCode).toBe(404);

    const res = await app.inject({
      method: 'POST',
      url: webhookPath,
      payload: { buildRef: 'build-42', environment: 'dev', commit: 'abc123' },
    });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json<{ runId: string }>();
    const run = await repos.runs.get(db, runId);
    expect(run).toMatchObject({ trigger: 'webhook', planId: plan.id, buildRef: 'build-42' });

    // body is optional; commit is the fallback build ref
    const bare = await app.inject({ method: 'POST', url: webhookPath });
    expect(bare.statusCode).toBe(202);
    const withCommit = await app.inject({ method: 'POST', url: webhookPath, payload: { commit: 'abc123' } });
    const r2 = await repos.runs.get(db, withCommit.json<{ runId: string }>().runId);
    expect(r2?.buildRef).toBe('abc123');

    expect((await app.inject({ method: 'POST', url: webhookPath, payload: { environment: 'nope' } })).statusCode).toBe(422);
    expect((await app.inject({ method: 'POST', url: webhookPath, payload: { bogus: 1 } })).statusCode).toBe(400);
  });

  it('regenerating the token invalidates the old URL', async () => {
    const { app, api, mkPlan } = await appWith();
    const plan = await mkPlan();
    const before = await api.triggers.get(plan.id);
    const after = await api.triggers.regenerateToken(plan.id);
    expect(after.token).not.toBe(before.token);
    expect((await app.inject({ method: 'POST', url: before.webhookPath })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: after.webhookPath })).statusCode).toBe(202);
  });
});
