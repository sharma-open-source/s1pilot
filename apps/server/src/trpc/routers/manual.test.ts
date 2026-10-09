import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createContext } from '../context.js';
import { appRouter, createCallerFactory } from '../router.js';

const makeCaller = createCallerFactory(appRouter);
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 's1p-manual-'));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = loadConfig({ dataDir, logLevel: 'silent' }, {});
  const db: Db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  const app = await buildApp(config, { db, workers: 0, scheduler: false, dev: false, webDist: join(dataDir, 'none') });
  cleanups.push(() => app.close());
  const api = makeCaller(createContext({ db, config, log: createLogger({ level: 'silent' }) }));
  await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  const env = (await api.environments.list({ projectKey: 'SHOP' }))[0] as { id: string };
  const c1 = await api.cases.create({
    projectKey: 'SHOP',
    title: 'Cart keeps items',
    steps: [{ action: 'Add Classic Tee', expected: 'Badge shows 1' }, { action: 'Reload the page' }, { action: 'Open the cart', expected: 'Tee is still there' }],
  });
  const c2 = await api.cases.create({ projectKey: 'SHOP', title: 'Checkout', steps: [{ action: 'Open the shop' }] });
  const plan = await api.plans.create({
    projectKey: 'SHOP',
    name: 'Manual pass',
    selection: { kind: 'list', caseIds: [c1.id, c2.id] },
    matrix: [{ environmentId: env.id, browser: 'chromium' }],
    assignments: { [c1.id]: { manual: true, hybrid: false }, [c2.id]: { manual: true, hybrid: false } },
  });
  const run = await api.runs.create({ projectKey: 'SHOP', planId: plan.id });
  const queue = await api.manual.myQueue({ projectKey: 'SHOP' });
  return { api, app, db, c1, c2, run, queue };
}

describe('manual router', () => {
  it('creates queue items for manual cases and records results with the worst step verdict', async () => {
    const { api, db, run, queue, c1 } = await setup();
    expect(queue.map((q) => [q.caseKey, q.status])).toEqual([
      [c1.key, 'todo'],
      ['SHOP-TC-2', 'todo'],
    ]);
    const first = queue[0]?.id as string;

    const started = await api.manual.start({ itemId: first });
    expect(started).toMatchObject({ position: 1, total: 2, title: 'Cart keeps items', timerRunning: true });
    expect(started.steps.map((s) => s.verdict)).toEqual([null, null, null]);

    await api.manual.recordStep({ itemId: first, stepIndex: 0, verdict: 'pass' });
    await expect(api.manual.finish({ itemId: first })).rejects.toThrow(/missing: 2, 3/);
    await api.manual.recordStep({ itemId: first, stepIndex: 1, verdict: 'na' });
    await api.manual.recordStep({ itemId: first, stepIndex: 2, verdict: 'fail', actual: 'Cart is empty after reload.' });
    const done = await api.manual.finish({ itemId: first });
    expect(done.verdict).toBe('failed');
    expect(done.nextItemId).toBe(queue[1]?.id);

    const results = await repos.results.listCases(db, run.id);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: done.caseResultId, mode: 'manual', verdict: 'failed', caseId: c1.id });
    const steps = await repos.results.listSteps(db, done.caseResultId);
    expect(steps.map((s) => s.status)).toEqual(['passed', 'skipped', 'failed']);
    expect(steps[2]?.actionTaken).toBe('Cart is empty after reload.');
    await expect(api.manual.recordStep({ itemId: first, stepIndex: 0, verdict: 'pass' })).rejects.toThrow(/already finished/);

    // The run stays open until the second item is done.
    expect((await repos.runs.get(db, run.id))?.status).toBe('running');
    const second = queue[1]?.id as string;
    await api.manual.recordStep({ itemId: second, stepIndex: 0, verdict: 'pass' });
    expect((await api.manual.finish({ itemId: second })).nextItemId).toBeNull();
    const final = await repos.runs.get(db, run.id);
    expect(final).toMatchObject({ status: 'failed', summary: { passed: 1, failed: 1 } });
    expect((await api.results.get(done.caseResultId)).result.mode).toBe('manual');
  });

  it('keeps the timer across reloads and skips cases', async () => {
    const { api, db, queue, run } = await setup();
    const id = queue[0]?.id as string;
    await api.manual.start({ itemId: id });
    const past = new Date(Date.now() - 65_000).toISOString();
    await repos.manual.update(db, id, { timerStartedAt: past });
    const again = await api.manual.get({ itemId: id });
    expect(again.timerRunning).toBe(true);
    expect(again.elapsedMs).toBeGreaterThanOrEqual(65_000);
    // start() on a running timer does not reset it
    expect((await api.manual.start({ itemId: id })).elapsedMs).toBeGreaterThanOrEqual(65_000);

    const skipped = await api.manual.skip({ itemId: id });
    expect(skipped.nextItemId).toBe(queue[1]?.id);
    const r = await repos.results.getCase(db, skipped.caseResultId);
    expect(r).toMatchObject({ verdict: 'skipped', mode: 'manual', reason: 'skipped by tester' });
    expect((await repos.results.getCase(db, skipped.caseResultId))?.durationMs).toBeGreaterThanOrEqual(65_000);
    expect((await repos.runs.get(db, run.id))?.status).toBe('running');
  });

  it('stores attachments and prefills a defect from a step', async () => {
    const { api, app, db, queue } = await setup();
    const id = queue[0]?.id as string;
    await api.manual.recordStep({ itemId: id, stepIndex: 0, verdict: 'pass' });
    await api.manual.recordStep({ itemId: id, stepIndex: 1, verdict: 'pass' });
    await api.manual.recordStep({ itemId: id, stepIndex: 2, verdict: 'fail', actual: 'Cart is empty after reload on Safari iOS.' });

    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const up = await app.inject({ method: 'POST', url: `/api/manual/${id}/attachments?step=2&name=cart.png`, headers: { 'content-type': 'image/png' }, payload: png });
    expect(up.statusCode).toBe(201);
    const { id: artifactId, url } = up.json() as { id: string; url: string };
    expect((await app.inject({ method: 'GET', url })).rawPayload.equals(png)).toBe(true);
    const bad = await app.inject({ method: 'POST', url: `/api/manual/${id}/attachments?step=2`, headers: { 'content-type': 'text/plain' }, payload: 'x' });
    expect(bad.statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: `/api/manual/nope/attachments?step=0`, headers: { 'content-type': 'image/png' }, payload: png })).statusCode).toBe(404);

    const view = await api.manual.get({ itemId: id });
    expect(view.steps[2]?.attachments).toMatchObject([{ id: artifactId, kind: 'screenshot', url }]);

    const draft = await api.manual.defectDraft({ itemId: id, stepIndex: 2 });
    expect(draft).toMatchObject({
      projectKey: 'SHOP',
      stepNumber: 3,
      title: 'Cart keeps items: Cart is empty after reload on Safari iOS.',
      details: {
        stepsToReproduce: ['Add Classic Tee', 'Reload the page', 'Open the cart'],
        expected: 'Tee is still there',
        actual: 'Cart is empty after reload on Safari iOS.',
        browser: 'chromium',
        sourceKind: 'manual',
        sourceLabel: 'SHOP-TC-1',
        evidence: [{ artifactId, kind: 'screenshot' }],
      },
    });

    // Finishing links the attachment to the step result as evidence.
    const done = await api.manual.finish({ itemId: id });
    const steps = await repos.results.listSteps(db, done.caseResultId);
    expect(steps[2]?.evidence).toEqual([{ kind: 'screenshot', artifactId }]);
    expect((await repos.artifacts.listByCaseResult(db, done.caseResultId)).map((a) => a.id)).toEqual([artifactId]);
  });

  it('saves notes and turns a note into a one-step draft case without System 2', async () => {
    const { api, queue } = await setup();
    const id = queue[0]?.id as string;
    await api.manual.notes.update({ itemId: id, notes: 'Coupon field is hidden on mobile' });
    expect((await api.manual.get({ itemId: id })).item.notes).toBe('Coupon field is hidden on mobile');
    const draft = await api.manual.noteToDraft({ itemId: id, note: 'Coupon field is hidden on mobile\nCheck on 400px' });
    expect(draft).toMatchObject({ title: 'Coupon field is hidden on mobile', structured: false });
    const created = await api.cases.get({ key: draft.key });
    expect(created).toMatchObject({ status: 'draft' });
    expect(created.steps).toHaveLength(1);
  });

  it('hybrid items show the AI pre-run result and let the tester confirm it', async () => {
    const { api, db, c1, c2, run } = await setup();
    const plan = (await api.plans.list({ projectKey: 'SHOP' }))[0] as { id: string };
    await api.plans.update({ id: plan.id, patch: { assignments: { [c1.id]: { manual: true, hybrid: true }, [c2.id]: { manual: true } } } });
    const run2 = await api.runs.create({ projectKey: 'SHOP', planId: plan.id });
    expect(run2.id).not.toBe(run.id);
    const items = await repos.manual.listByRun(db, run2.id);
    expect(items).toHaveLength(2);
    expect(items[0]?.hybrid).toBe(true);
    // the hybrid case is also queued as an automated pre-run job
    expect(db.sqlite.prepare('select count(*) as n from jobs where run_id = ?').get(run2.id)).toEqual({ n: 1 });
    // simulate the AI pre-run result
    await repos.results.createCase(db, { id: 'pre1', runId: run2.id, caseId: c1.id, caseVersion: 1, environmentId: items[0]?.environmentId as string, browser: 'chromium', verdict: 'passed', durationMs: 10, mode: 'explore' });
    await repos.results.addStep(db, { id: 'pre1-0', caseResultId: 'pre1', stepIndex: 0, status: 'passed' });
    await repos.results.addStep(db, { id: 'pre1-1', caseResultId: 'pre1', stepIndex: 1, status: 'passed' });
    const id = items[0]?.id as string;
    const view = await api.manual.get({ itemId: id });
    expect(view.steps.map((s) => s.preRun)).toEqual(['passed', 'passed', null]);
    await api.manual.confirmPreRun({ itemId: id, stepIndex: 0 });
    await expect(api.manual.confirmPreRun({ itemId: id, stepIndex: 2 })).rejects.toThrow(/no AI pre-run/);
    await api.manual.recordStep({ itemId: id, stepIndex: 1, verdict: 'pass' });
    await api.manual.recordStep({ itemId: id, stepIndex: 2, verdict: 'pass' });
    const done = await api.manual.finish({ itemId: id });
    expect(done.verdict).toBe('passed');
    // the pre-run result is superseded by the manual one
    expect((await repos.results.listCases(db, run2.id)).map((r) => r.mode)).toEqual(['manual']);
  });
});
