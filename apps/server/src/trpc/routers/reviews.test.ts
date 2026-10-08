import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { newId, type CaseRunResult, type LocatorCandidate, type ResolvedAction } from '@s1pilot/domain';
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

const GUEST: LocatorCandidate = { kind: 'role', value: 'button', name: 'Guest checkout' };
const RENAMED: LocatorCandidate = { kind: 'role', value: 'button', name: 'Checkout as guest' };
const action = (stepIndex: number, locator: LocatorCandidate): ResolvedAction => ({
  stepIndex,
  subIndex: 0,
  action: 'click',
  locators: [locator],
  fingerprint: 'fp',
  stepHash: 'hash-guest',
  fromRunId: 'r1',
});

async function setup() {
  const db = openDb({ url: ':memory:', crypto: await createVault({ masterKey: Buffer.alloc(32, 7).toString('base64') }) });
  dbs.push(db);
  const config = loadConfig({ dataDir: '/tmp/s1pilot-test-nonexistent/.s1pilot', logLevel: 'silent' }, {});
  const ctx = createContext({ db, config, log: createLogger({ level: 'silent' }) });
  const api = makeCaller(ctx);
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  const env = await repos.environments.create(db, { id: newId(), projectId: project.id, name: 'staging', baseUrl: 'http://a.test' });
  const flow = await repos.sharedSteps.create(db, { id: newId(), projectId: project.id, name: 'guest-checkout', params: [], steps: [{ action: 'Go to checkout as guest' }] });
  const stepsFor = (n: number) => [...Array.from({ length: n }, (_, i) => ({ action: `Prepare ${i}` })), { action: 'Go to checkout as guest', sharedStepId: flow.id }];
  const a = await api.cases.create({ projectKey: 'SHOP', title: 'Guest A', steps: stepsFor(1) });
  const b = await api.cases.create({ projectKey: 'SHOP', title: 'Guest B', steps: stepsFor(2) });
  for (const [c, i] of [[a, 1], [b, 2]] as const) {
    await repos.learnedScripts.upsert(db, { id: newId(), caseId: c.id, caseVersion: 1, environmentId: env.id, createdFromRunId: 'r1', actions: [action(i, GUEST)] });
  }
  const proposal = await repos.healProposals.create(db, {
    id: newId(), caseId: a.id, environmentId: env.id, runId: 'r2', stepIndex: 1, sharedStepId: flow.id,
    before: [action(1, GUEST)], after: [action(1, RENAMED)], confidence: 0.62, s2Agreed: true,
  });
  // A needs-review run with one uncertain AI assertion.
  await repos.runs.create(db, {
    id: 'run1', projectId: project.id, trigger: 'manual', status: 'needs-review',
    summary: { passed: 0, failed: 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 1 },
  });
  await repos.results.createCase(db, { id: 'cr1', runId: 'run1', caseId: a.id, caseVersion: 1, environmentId: env.id, verdict: 'needs-review', durationMs: 5, mode: 'explore', browser: 'webkit' });
  await repos.results.addStep(db, {
    id: 'cr1-0', caseResultId: 'cr1', stepIndex: 0, status: 'passed',
    decisions: [{ questionId: 'q', options: ['yes', 'no'], probabilities: { yes: 0.55, no: 0.45 }, confidence: 0.55, model: 'clef-flash', latencyMs: 3 }],
    assertions: [{ assertion: 'ai', verdict: 'needs-review', probability: 0.55 }],
  });
  await repos.reviews.create(db, { id: 'rv1', projectId: project.id, kind: 'verdict', refId: 'cr1', status: 'pending' });
  const scriptName = async (caseId: string) => (await repos.learnedScripts.getFor(db, caseId, env.id))?.actions.map((x) => x.locators[0]?.name);
  return { api, db, ctx, project, env, a, b, proposal, scriptName };
}

describe('reviews router', () => {
  it('counts pending items per tab and lists them', async () => {
    const { api, proposal } = await setup();
    expect(await api.reviews.counts({ projectKey: 'SHOP' })).toEqual({ verdicts: 1, heals: 1, drafts: 0, visual: 0 });
    const heals = await api.reviews.list({ projectKey: 'SHOP', tab: 'heals' });
    expect(heals.total).toBe(1);
    expect(heals.items[0]).toMatchObject({ title: '“Guest checkout” → “Checkout as guest”', impactCount: 2, sharedStepName: 'guest-checkout', confidence: 0.62 });
    const verdicts = await api.reviews.list({ projectKey: 'SHOP', tab: 'verdicts' });
    expect(verdicts.items[0]).toMatchObject({ id: 'rv1', title: 'Guest A', confidence: 0.55, browser: 'webkit' });
    expect((await api.reviews.list({ projectKey: 'SHOP', tab: 'drafts' })).items).toEqual([]);
    const detail = await api.reviews.get(heals.items[0]?.id as string);
    expect(detail).toMatchObject({
      kind: 'heal',
      proposalId: proposal.id,
      before: ["getByRole('button', {name: 'Guest checkout'})"],
      after: ["getByRole('button', {name: 'Checkout as guest'})"],
      s2Agreed: true,
      impactCount: 2,
    });
  });

  it('approving a heal for all cases updates every impacted learned script', async () => {
    const { api, a, b, scriptName } = await setup();
    const id = (await api.reviews.list({ projectKey: 'SHOP', tab: 'heals' })).items[0]?.id as string;
    const out = await api.reviews.decide({ id, decision: 'approve', note: 'Intentional rename' });
    expect(out.item).toMatchObject({ status: 'approved', note: 'Intentional rename' });
    expect(await scriptName(a.id)).toEqual(['Checkout as guest']);
    expect(await scriptName(b.id)).toEqual(['Checkout as guest']);
    expect((await api.reviews.counts({ projectKey: 'SHOP' })).heals).toBe(0);
    await expect(api.reviews.decide({ id, decision: 'reject', note: '' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect((await api.reviews.list({ projectKey: 'SHOP', tab: 'heals', status: 'resolved' })).total).toBe(1);
  });

  it('approve-case-only touches one script, reject touches none', async () => {
    const one = await setup();
    const id1 = (await one.api.reviews.list({ projectKey: 'SHOP', tab: 'heals' })).items[0]?.id as string;
    await one.api.reviews.decide({ id: id1, decision: 'approve-case-only', note: '' });
    expect(await one.scriptName(one.a.id)).toEqual(['Checkout as guest']);
    expect(await one.scriptName(one.b.id)).toEqual(['Guest checkout']);
    const two = await setup();
    const id2 = (await two.api.reviews.list({ projectKey: 'SHOP', tab: 'heals' })).items[0]?.id as string;
    const out = await two.api.reviews.decide({ id: id2, decision: 'reject', note: 'Looks like a bug' });
    expect(out.item.status).toBe('rejected');
    expect(await two.scriptName(two.a.id)).toEqual(['Guest checkout']);
  });

  it('deciding a verdict updates the run counts and records a ReviewOutcome', async () => {
    const { api, db } = await setup();
    const detail = await api.reviews.get('rv1');
    expect(detail).toMatchObject({ kind: 'verdict', pTrue: 0.55, assertions: [{ probability: 0.55 }] });
    const out = await api.reviews.decide({ id: 'rv1', decision: 'approve', note: 'Looks right' });
    expect(out.item).toMatchObject({ status: 'approved', outcome: { pTrue: 0.55, humanVerdict: 'passed', questionType: 'noul', optionCount: 2, model: 'clef-flash' } });
    const run = await repos.runs.get(db, 'run1');
    expect(run?.summary).toMatchObject({ passed: 1, needsReview: 0 });
    expect(run?.status).toBe('passed');
    expect((await repos.results.getCase(db, 'cr1'))?.verdict).toBe('passed');
    expect(await api.reviews.counts({ projectKey: 'SHOP' })).toMatchObject({ verdicts: 0 });
  });

  it('an override of a pending item resolves it instead of adding another', async () => {
    const { api, db, project } = await setup();
    await api.results.overrideVerdict({ resultId: 'cr1', verdict: 'failed', note: 'Wrong' });
    const items = await repos.reviews.list(db, { projectId: project.id, kind: 'verdict' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'rv1', status: 'approved', outcome: { humanVerdict: 'failed', pTrue: 0.55 } });
    expect((await repos.runs.get(db, 'run1'))?.status).toBe('failed');
  });

  it('pushes the new review count to /ws/workspace clients after a decision', async () => {
    const { api, ctx } = await setup();
    const messages: Array<{ reviewCount?: number }> = [];
    await ctx.runtime.live.subscribeWorkspace({ sendText: (t: string) => void messages.push(JSON.parse(t) as { reviewCount?: number }) } as never);
    expect(messages.at(-1)?.reviewCount).toBe(2);
    await api.reviews.decide({ id: 'rv1', decision: 'approve', note: '' });
    expect(messages.at(-1)?.reviewCount).toBe(1);
    const heal = (await api.reviews.list({ projectKey: 'SHOP', tab: 'heals' })).items[0]?.id as string;
    await api.reviews.decide({ id: heal, decision: 'reject', note: '' });
    expect(messages.at(-1)?.reviewCount).toBe(0);
  });

  it('rejects approve-case-only on verdicts and unknown ids', async () => {
    const { api } = await setup();
    await expect(api.reviews.decide({ id: 'rv1', decision: 'approve-case-only', note: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(api.reviews.get('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns the next pending item for auto-advance', async () => {
    const { api, db, project, a } = await setup();
    await repos.results.createCase(db, { id: 'cr2', runId: 'run1', caseId: a.id, caseVersion: 1, verdict: 'needs-review', durationMs: 1, mode: 'explore' });
    await repos.reviews.create(db, { id: 'rv2', projectId: project.id, kind: 'verdict', refId: 'cr2', status: 'pending' });
    const first = (await api.reviews.list({ projectKey: 'SHOP', tab: 'verdicts' })).items;
    expect(first).toHaveLength(2);
    const out = await api.reviews.decide({ id: first[0]?.id as string, decision: 'reject', note: '' });
    expect(out.nextId).toBe(first[1]?.id);
  });
});

describe('run lifecycle', () => {
  it('queues a pending verdict item for a needs-review case and drops it when the case is discarded', async () => {
    const { ctx, db, project, a, env } = await setup();
    const testCase = (await repos.cases.get(db, a.id)) as NonNullable<Awaited<ReturnType<typeof repos.cases.get>>>;
    await repos.runs.create(db, { id: 'run2', projectId: project.id, trigger: 'manual', status: 'running' });
    const result = { caseResultId: 'cr9', verdict: 'needs-review', durationMs: 4, mode: 'explore', browser: 'chromium', steps: [] } as unknown as CaseRunResult;
    await ctx.runtime.lifecycle.recordCase({ runId: 'run2', testCase, environmentId: env.id, attempt: 1, result });
    const refs = async () => (await repos.reviews.list(db, { projectId: project.id, kind: 'verdict', status: 'pending' })).map((i) => i.refId);
    expect(await refs()).toContain('cr9');
    await ctx.runtime.lifecycle.discardCase('run2', a.id);
    expect(await refs()).not.toContain('cr9');
  });
});
