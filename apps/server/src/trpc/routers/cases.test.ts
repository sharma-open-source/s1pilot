import { createVault, openDb, repos, type Db } from '@s1pilot/db';
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
  const viewer = makeCaller({ ...ctx, user: { id: 'v', role: 'viewer' } });
  return { api, db, viewer };
}

afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
});

const steps = [{ action: 'Open the shop', expected: 'Shop home is shown' }, { action: 'Add an item to the cart' }];
const mk = (api: Awaited<ReturnType<typeof setup>>['api'], over: Record<string, unknown> = {}) =>
  api.cases.create({ projectKey: 'SHOP', title: 'A case', steps, ...over });

describe('cases.list query filter', () => {
  it('tags:checkout AND priority<=P1 returns only matching cases', async () => {
    const { api } = await setup();
    await mk(api, { title: 'Guest checkout', tags: ['checkout'], priority: 'P0' });
    await mk(api, { title: 'Member checkout', tags: ['checkout'], priority: 'P1' });
    await mk(api, { title: 'Low checkout', tags: ['checkout'], priority: 'P2' });
    await mk(api, { title: 'Cart badge', tags: ['cart'], priority: 'P0' });

    const res = await api.cases.list({ projectKey: 'SHOP', query: 'tags:checkout AND priority<=P1' });
    expect(res.total).toBe(2);
    expect(res.items.map((c) => c.title).sort()).toEqual(['Guest checkout', 'Member checkout']);
    expect(res.items[0]).toMatchObject({ stepCount: 2, learned: [{ environmentName: 'dev', status: 'none' }], lastResult: null });

    const text = await api.cases.list({ projectKey: 'SHOP', query: 'badge status:draft' });
    expect(text.items.map((c) => c.title)).toEqual(['Cart badge']);
    await expect(api.cases.list({ projectKey: 'SHOP', query: 'priority<=P9' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('pages, sorts and scopes to a suite including sub-suites', async () => {
    const { api } = await setup();
    const { id: a } = await api.suites.create({ projectKey: 'SHOP', name: 'Checkout' });
    const { id: b } = await api.suites.create({ projectKey: 'SHOP', name: 'Guest', parentId: a });
    for (const [i, suiteId] of [a, b, undefined, b].entries()) {
      await mk(api, { title: `Case ${i}`, ...(suiteId ? { suiteId } : {}) });
    }
    const scoped = await api.cases.list({ projectKey: 'SHOP', suiteId: a });
    expect(scoped.total).toBe(3);
    const p2 = await api.cases.list({ projectKey: 'SHOP', page: 2, pageSize: 3, sort: { by: 'title', dir: 'desc' } });
    expect(p2.total).toBe(4);
    expect(p2.items.map((c) => c.title)).toEqual(['Case 0']);
    expect(scoped.items.find((c) => c.title === 'Case 1')?.suitePath.map((s) => s.name)).toEqual(['Checkout', 'Guest']);
  });
});

describe('cases.update', () => {
  it('bumps the version and rejects a stale expectedVersion with CONFLICT', async () => {
    const { api } = await setup();
    const c = await mk(api);
    expect(c.version).toBe(1);
    const v2 = await api.cases.update({ key: c.key, expectedVersion: 1, patch: { title: 'Renamed' } });
    expect(v2).toMatchObject({ version: 2, title: 'Renamed' });
    await expect(
      api.cases.update({ key: c.key, expectedVersion: 1, patch: { title: 'Stale write' } }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await api.cases.get(c.key)).title).toBe('Renamed');
    await expect(api.cases.update({ key: 'SHOP-TC-99', expectedVersion: 1, patch: {} })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('handles concurrent updates: exactly one wins', async () => {
    const { api } = await setup();
    const c = await mk(api);
    const results = await Promise.allSettled([
      api.cases.update({ key: c.key, expectedVersion: 1, patch: { title: 'one' } }),
      api.cases.update({ key: c.key, expectedVersion: 1, patch: { title: 'two' } }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await api.cases.get(c.key)).version).toBe(2);
  });
});

describe('history and diff', () => {
  it('returns a unified step-level diff between versions', async () => {
    const { api } = await setup();
    const c = await mk(api);
    await api.cases.update({
      key: c.key,
      expectedVersion: 1,
      patch: { steps: [steps[0] as (typeof steps)[0], { action: 'Add two items to the cart' }, { action: 'Open the cart' }] },
    });
    const history = await api.cases.history({ key: c.key });
    expect(history.map((h) => h.version)).toEqual([2, 1]);

    const d = await api.cases.diff({ key: c.key, fromVersion: 1, toVersion: 2 });
    expect(d.unified).toContain('--- SHOP-TC-1@v1');
    expect(d.unified).toContain('-  - action: Add an item to the cart');
    expect(d.unified).toContain('+  - action: Add two items to the cart');
    expect(d.unified).toContain('+  - action: Open the cart');
    expect(d.steps.map((s) => s.change)).toEqual(['unchanged', 'changed', 'added']);
    await expect(api.cases.diff({ key: c.key, fromVersion: 1, toVersion: 9 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('YAML', () => {
  it('round-trips through the API without changing the case', async () => {
    const { api } = await setup();
    const flow = await api.sharedSteps.create({ projectKey: 'SHOP', name: 'login', params: ['user'], steps: [{ action: 'Sign in as {user}' }] });
    const c = await mk(api, {
      tags: ['b', 'a'],
      owner: 'ann',
      parameters: [{ qty: 1 }],
      steps: [
        { action: 'Open the shop', expected: 'Shop home is shown', assert: [{ type: 'urlMatches', pattern: '/shop' }] },
        { action: 'Run flow login', sharedStepId: flow.id, args: { user: 'ann' } },
      ],
    });
    const before = await api.cases.get(c.key);
    const { yaml, version } = await api.cases.yaml({ key: c.key });
    expect(version).toBe(1);
    expect(yaml).toContain('flow: login');

    const after = await api.cases.updateFromYaml({ key: c.key, yaml });
    expect(after.version).toBe(1);
    const reread = await api.cases.get(c.key);
    expect(reread).toMatchObject({ title: before.title, tags: before.tags, owner: 'ann', version: 1, updatedAt: before.updatedAt });
    expect(reread.steps.map((s) => s.sharedStepId)).toEqual([undefined, flow.id]);
    expect((await api.cases.yaml({ key: c.key })).yaml).toBe(yaml);
  });

  it('applies edits, bumps the version, and validates input', async () => {
    const { api } = await setup();
    const c = await mk(api, { owner: 'ann' });
    const { yaml } = await api.cases.yaml({ key: c.key });
    const edited = await api.cases.updateFromYaml({ key: c.key, yaml: yaml.replace('A case', 'Edited').replace('owner: ann\n', '') });
    expect(edited).toMatchObject({ version: 2, title: 'Edited' });
    expect(edited.owner).toBeUndefined();

    await expect(api.cases.updateFromYaml({ key: c.key, yaml: yaml })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(api.cases.updateFromYaml({ key: c.key, yaml: 'title: [' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.cases.updateFromYaml({ key: c.key, yaml: 'key: SHOP-TC-1\ntitle: x\nsteps: []\n' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    const other = yaml.replace('key: SHOP-TC-1', 'key: SHOP-TC-7');
    await expect(api.cases.updateFromYaml({ key: c.key, yaml: other, expectedVersion: 2 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const unknownFlow = yaml.replace(/steps:[\s\S]*/, 'steps:\n  - flow: nope\n');
    await expect(api.cases.updateFromYaml({ key: c.key, yaml: unknownFlow, expectedVersion: 2 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('bulk', () => {
  it('moves, tags, sets status and deletes', async () => {
    const { api } = await setup();
    const { id: suite } = await api.suites.create({ projectKey: 'SHOP', name: 'S' });
    const a = await mk(api, { tags: ['x'] });
    const b = await mk(api);
    const ids = [a.id, b.id];

    await api.cases.bulk({ ids, action: 'move', suiteId: suite });
    expect((await api.cases.get(a.key)).suiteId).toBe(suite);
    await api.cases.bulk({ ids, action: 'tag', add: ['new'], remove: ['x'] });
    expect((await api.cases.get(a.key)).tags).toEqual(['new']);
    await api.cases.bulk({ ids, action: 'setStatus', status: 'ready' });
    expect((await api.cases.get(b.key)).status).toBe('ready');
    await api.cases.bulk({ ids: [a.id], action: 'move', suiteId: null });
    expect((await api.cases.get(a.key)).suiteId).toBeUndefined();

    await expect(api.cases.bulk({ ids: [a.id, 'nope'], action: 'delete' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await api.cases.list({ projectKey: 'SHOP' })).total).toBe(2);
    expect(await api.cases.bulk({ ids, action: 'delete' })).toMatchObject({ affected: 2 });
    expect((await api.cases.list({ projectKey: 'SHOP' })).total).toBe(0);
  });

  it('refuses deletes by viewers and drops deleted cases from list plans', async () => {
    const { api, viewer } = await setup();
    const a = await mk(api);
    const b = await mk(api);
    const env = (await api.environments.list({ projectKey: 'SHOP' }))[0];
    if (!env) throw new Error('no environment');
    const plan = await api.plans.create({
      projectKey: 'SHOP',
      name: 'Picked',
      selection: { kind: 'list', caseIds: [a.id, b.id] },
      matrix: [{ environmentId: env.id, browser: 'chromium' }],
    });

    await expect(viewer.cases.bulk({ ids: [a.id], action: 'delete' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await api.cases.bulk({ ids: [a.id], action: 'delete' });
    expect((await api.plans.get(plan.id)).selection).toEqual({ kind: 'list', caseIds: [b.id] });
    // The plan can still be saved (its list no longer names a missing case).
    await expect(api.plans.update({ id: plan.id, patch: { retries: 1 } })).resolves.toMatchObject({ retries: 1 });
  });
});

describe('suites', () => {
  it('builds a nested tree with counts and supports rename/move/delete', async () => {
    const { api } = await setup();
    const a = await api.suites.create({ projectKey: 'SHOP', name: 'A' });
    const b = await api.suites.create({ projectKey: 'SHOP', name: 'B', parentId: a.id });
    const c = await api.suites.create({ projectKey: 'SHOP', name: 'C' });
    await mk(api, { suiteId: b.id });
    await mk(api, { suiteId: a.id });
    await mk(api);

    const t = await api.suites.tree({ projectKey: 'SHOP' });
    expect(t).toMatchObject({ totalCases: 3, unsortedCases: 1 });
    expect(t.tree.map((n) => [n.name, n.caseCount, n.totalCount])).toEqual([['A', 1, 2], ['C', 0, 0]]);
    expect(t.tree[0]?.children.map((n) => [n.name, n.totalCount])).toEqual([['B', 1]]);

    expect((await api.suites.rename({ id: c.id, name: 'C2' })).name).toBe('C2');
    await expect(api.suites.move({ id: a.id, parentId: b.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await api.suites.move({ id: c.id, parentId: a.id });
    await api.suites.move({ id: c.id, parentId: null });
    expect((await api.suites.tree({ projectKey: 'SHOP' })).tree.map((n) => n.name)).toEqual(['A', 'C2']);

    await expect(api.suites.delete({ id: a.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(api.suites.delete({ id: a.id, moveCasesTo: b.id })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await api.suites.delete({ id: a.id, moveCasesTo: c.id })).toMatchObject({ movedCases: 2 });
    expect((await api.suites.tree({ projectKey: 'SHOP' })).tree).toMatchObject([{ name: 'C2', caseCount: 2 }]);
    expect(await api.suites.delete({ id: c.id, moveCasesTo: null })).toMatchObject({ movedCases: 2 });
    expect((await api.suites.tree({ projectKey: 'SHOP' })).unsortedCases).toBe(3);
  });
});

describe('sharedSteps', () => {
  it('lists with usage counts, updates and rejects duplicate names', async () => {
    const { api } = await setup();
    const f = await api.sharedSteps.create({ projectKey: 'SHOP', name: 'login', steps: [{ action: 'Sign in' }] });
    await expect(
      api.sharedSteps.create({ projectKey: 'SHOP', name: 'login', steps: [{ action: 'x' }] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const c = await mk(api, { steps: [{ action: 'Run flow login', sharedStepId: f.id }] });
    await mk(api);
    expect((await api.sharedSteps.list({ projectKey: 'SHOP' }))[0]).toMatchObject({ name: 'login', usageCount: 1 });
    expect(await api.sharedSteps.get({ id: f.id })).toMatchObject({ usedBy: [c.key] });
    const u = await api.sharedSteps.update({ id: f.id, name: 'sign-in', params: ['user'] });
    expect(u).toMatchObject({ name: 'sign-in', params: ['user'], steps: [{ action: 'Sign in' }] });
    await expect(api.sharedSteps.get({ id: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('requirements', () => {
  it('creates, links and unlinks (keeping the case list in sync)', async () => {
    const { api } = await setup();
    const r = await api.requirements.create({ projectKey: 'SHOP', title: 'Guest checkout' });
    expect(r.key).toBe('SHOP-REQ-1');
    await expect(api.requirements.create({ projectKey: 'SHOP', key: 'SHOP-REQ-1', title: 'dup' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const c = await mk(api);
    expect(await api.requirements.link({ caseKey: c.key, reqKey: r.key })).toMatchObject({ caseVersion: 2 });
    expect(await api.requirements.link({ caseKey: c.key, reqKey: r.key })).toMatchObject({ caseVersion: 2 });
    expect((await api.cases.get(c.key)).requirements).toEqual([r.key]);
    expect((await api.requirements.list({ projectKey: 'SHOP' }))[0]).toMatchObject({ caseKeys: [c.key], coverage: 1 });
    await api.requirements.unlink({ caseKey: c.key, reqKey: r.key });
    expect((await api.requirements.list({ projectKey: 'SHOP' }))[0]).toMatchObject({ caseKeys: [], coverage: 0 });
    await expect(api.requirements.link({ caseKey: c.key, reqKey: 'NOPE' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('list row extras', () => {
  it('shows learned-script status per env and the latest result', async () => {
    const { api, db } = await setup();
    const c = await mk(api);
    const env = (await api.environments.list({ projectKey: 'SHOP' }))[0];
    if (!env) throw new Error('no env');
    const projectId = c.projectId;
    for (const [i, verdict] of (['failed', 'passed'] as const).entries()) {
      const run = await repos.runs.create(db, {
        id: `run${i}`, projectId, trigger: 'manual', status: 'finished', startedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
      await repos.results.createCase(db, {
        id: `res${i}`, runId: run.id, caseId: c.id, caseVersion: 1, verdict, durationMs: 10, mode: 'explore',
      });
    }
    await repos.learnedScripts.upsert(db, {
      id: 'ls1', caseId: c.id, caseVersion: 1, environmentId: env.id, actions: [], createdFromRunId: 'run1',
    });
    const row = (await api.cases.list({ projectKey: 'SHOP' })).items[0];
    expect(row?.lastResult).toMatchObject({ runId: 'run1', verdict: 'passed' });
    expect(row?.learned[0]).toMatchObject({ environmentName: 'dev', status: 'current' });
    await api.cases.update({ key: c.key, expectedVersion: 1, patch: { title: 'v2' } });
    expect((await api.cases.get(c.key)).learned[0]?.status).toBe('stale');
  });
});

describe('syncStatus', () => {
  it('reports a project with no exported files as not clean', async () => {
    const { api } = await setup();
    await mk(api);
    const s = await api.syncStatus({ projectKey: 'SHOP' });
    expect(s.clean).toBe(false);
    expect(s.changedFiles.length).toBeGreaterThan(0);
  });
});
