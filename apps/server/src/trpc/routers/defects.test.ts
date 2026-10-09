import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

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
  const env = await repos.environments.create(db, { id: newId(), projectId: project.id, name: 'staging', baseUrl: 'http://a.test' });
  const c1 = await api.cases.create({
    projectKey: 'SHOP',
    title: 'Cart badge',
    steps: [{ action: 'Open the shop' }, { action: 'Add "Classic Tee" to the cart', expected: 'Badge shows 1' }, { action: 'Open the cart' }],
  });
  const c2 = await api.cases.create({ projectKey: 'SHOP', title: 'Checkout', steps: [{ action: 'Open the shop' }] });
  await repos.runs.create(db, { id: 'run1', projectId: project.id, trigger: 'manual', status: 'failed', buildRef: 'abc1234' });
  const failed = async (id: string, caseId: string, browser: 'chromium' | 'webkit') => {
    await repos.results.createCase(db, { id, runId: 'run1', caseId, caseVersion: 1, environmentId: env.id, verdict: 'failed', durationMs: 5, mode: 'replay', browser });
  };
  await failed('cr1', c1.id, 'webkit');
  await failed('cr2', c2.id, 'chromium');
  await repos.results.addStep(db, { id: 'cr1-0', caseResultId: 'cr1', stepIndex: 0, status: 'passed' });
  await repos.results.addStep(db, {
    id: 'cr1-1',
    caseResultId: 'cr1',
    stepIndex: 1,
    status: 'failed',
    assertions: [{ assertion: 'text', verdict: 'fail', message: 'expected text(status) ⊇ "1", got "2"' }],
  });
  return { api, db, ctx, project, env, c1, c2 };
}

describe('defects router', () => {
  it('prefills a draft from a failed result', async () => {
    const { api } = await setup();
    const draft = await api.defects.createFromResult({ resultId: 'cr1' });
    expect(draft).toMatchObject({
      projectKey: 'SHOP',
      stepNumber: 2,
      title: 'Cart badge: expected text(status) ⊇ "1", got "2"',
      details: {
        stepsToReproduce: ['Open the shop', 'Add "Classic Tee" to the cart'],
        expected: 'Badge shows 1',
        actual: 'expected text(status) ⊇ "1", got "2"',
        environment: 'staging',
        browser: 'webkit',
        buildRef: 'abc1234',
        retest: true,
      },
    });
    expect(draft.details.sourceLabel).toMatch(/TC-/);
  });

  it('creates, lists, filters and links defects', async () => {
    const { api } = await setup();
    const draft = await api.defects.createFromResult({ resultId: 'cr1' });
    const a = await api.defects.create({ projectKey: 'SHOP', title: draft.title, severity: 'S2', details: draft.details, resultIds: ['cr1'] });
    const b = await api.defects.create({ projectKey: 'SHOP', title: 'Typo in footer', severity: 'S4', status: 'draft' });
    expect(a).toMatchObject({ seq: 1, status: 'open', linkedResultIds: ['cr1'] });
    expect(b.seq).toBe(2);
    const all = await api.defects.list({ projectKey: 'SHOP' });
    expect(all.items.map((d) => d.key)).toEqual(['DEF-2', 'DEF-1']);
    expect(all.items[1]).toMatchObject({ failingBrowsers: ['webkit'], failingCount: 1, tracker: null, severity: 'S2' });
    expect((await api.defects.list({ projectKey: 'SHOP', query: 'status:open' })).items.map((d) => d.key)).toEqual(['DEF-1']);
    expect((await api.defects.list({ projectKey: 'SHOP', query: 'status:draft OR severity:S2' })).items).toHaveLength(2);
    expect((await api.defects.list({ projectKey: 'SHOP', query: 'tracker:none AND NOT status:draft' })).items).toHaveLength(1);
    await expect(api.defects.list({ projectKey: 'SHOP', query: 'status:bogus' })).rejects.toMatchObject({ message: expect.stringContaining('Unknown status') });
    await api.defects.linkResult({ defectId: b.id, resultId: 'cr2' });
    expect((await api.defects.get(b.id)).linked).toHaveLength(1);
  });

  it('closing with re-test on queues the linked failed cases as a retest run', async () => {
    const { api, db, ctx, project, c1, c2 } = await setup();
    const d = await api.defects.create({ projectKey: 'SHOP', title: 'Cart', severity: 'S1', details: { retest: true }, resultIds: ['cr1', 'cr2'] });
    const closed = await api.defects.close(d.id);
    expect(closed.status).toBe('closed');
    const runs = (await repos.runs.listByProject(db, project.id, 10)).filter((r) => r.trigger === 'retest');
    expect(runs).toHaveLength(1);
    expect(closed.details?.retestRunId).toBe(runs[0]?.id);
    const jobs = await ctx.runtime.queue.listByRun(runs[0]?.id as string);
    expect(jobs.map((j) => (j.payload as { caseId: string }).caseId).sort()).toEqual([c1.id, c2.id].sort());
    expect(jobs.map((j) => (j.payload as { browser: string }).browser).sort()).toEqual(['chromium', 'webkit']);
    // Moving between fixed and closed does not queue a second run.
    await api.defects.update({ id: d.id, status: 'fixed' });
    expect((await repos.runs.listByProject(db, project.id, 10)).filter((r) => r.trigger === 'retest')).toHaveLength(1);
  });

  it('does not re-test when the flag is off', async () => {
    const { api, db, project } = await setup();
    const d = await api.defects.create({ projectKey: 'SHOP', title: 'Cart', severity: 'S3', details: { retest: false }, resultIds: ['cr1'] });
    await api.defects.update({ id: d.id, status: 'fixed' });
    expect((await repos.runs.listByProject(db, project.id, 10)).filter((r) => r.trigger === 'retest')).toHaveLength(0);
  });
});
