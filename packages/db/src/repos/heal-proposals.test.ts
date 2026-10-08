import { newId, type LocatorCandidate, type ResolvedAction } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { caseInput, makeProject, memoryDb } from '../test-utils.js';

import { repos } from './index.js';

const GUEST: LocatorCandidate = { kind: 'role', value: 'button', name: 'Guest checkout' };
const RENAMED: LocatorCandidate = { kind: 'role', value: 'button', name: 'Checkout as guest' };

function action(stepIndex: number, locator: LocatorCandidate, stepHash = 'hash-guest'): ResolvedAction {
  return { stepIndex, subIndex: 0, action: 'click', locators: [locator], fingerprint: 'fp', stepHash, fromRunId: 'r1' };
}

async function setup() {
  const db = memoryDb();
  const project = await makeProject(db);
  const env = await repos.environments.create(db, { id: newId(), projectId: project.id, name: 'dev', baseUrl: 'http://localhost:3000' });
  const flow = await repos.sharedSteps.create(db, {
    id: newId(), projectId: project.id, name: 'guest-checkout', params: [], steps: [{ action: 'Go to checkout as guest' }],
  });
  const stepsFor = (n: number) => [
    ...Array.from({ length: n }, (_, i) => ({ action: `Prepare ${i}` })),
    { action: 'Go to checkout as guest', sharedStepId: flow.id },
  ];
  const a = await repos.cases.create(db, project.id, { ...caseInput('A'), steps: stepsFor(1) });
  const b = await repos.cases.create(db, project.id, { ...caseInput('B'), steps: stepsFor(2) });
  const other = await repos.cases.create(db, project.id, caseInput('Other'));
  const scriptFor = (caseId: string, index: number) =>
    repos.learnedScripts.upsert(db, {
      id: newId(), caseId, caseVersion: 1, environmentId: env.id, createdFromRunId: 'r1',
      actions: [action(index, GUEST)],
    });
  const scripts = { a: await scriptFor(a.id, 1), b: await scriptFor(b.id, 2), other: await scriptFor(other.id, 0) };
  const propose = (over: object = {}) =>
    repos.healProposals.create(db, {
      id: newId(), caseId: a.id, environmentId: env.id, runId: 'r2', stepIndex: 1, sharedStepId: flow.id,
      before: [action(1, GUEST)], after: [action(1, RENAMED)], confidence: 0.93, ...over,
    });
  return { db, project, env, a, b, other, flow, scripts, propose };
}

const nameOf = async (db: ReturnType<typeof memoryDb>, caseId: string, envId: string) =>
  (await repos.learnedScripts.getFor(db, caseId, envId))?.actions.map((x) => x.locators[0]?.name);

describe('healProposals repo', () => {
  it('creates a pending proposal, computes impact from the shared step and queues a review item', async () => {
    const { db, project, env, a, b, other, propose } = await setup();
    const p = await propose();
    expect(p.status).toBe('pending');
    expect(new Set(p.impactCaseIds)).toEqual(new Set([a.id, b.id]));
    expect(p.impactCaseIds).not.toContain(other.id);
    expect(await repos.healProposals.list(db, { status: 'pending' })).toHaveLength(1);
    expect(await repos.healProposals.list(db, { caseId: b.id })).toHaveLength(0);
    expect((await repos.reviews.list(db, { projectId: project.id, kind: 'heal', status: 'pending' }))[0]?.refId).toBe(p.id);
    expect((await repos.learnedScripts.getFor(db, a.id, env.id))?.health.pendingProposals).toBe(1);
    // Scripts are untouched until review.
    expect(await nameOf(db, a.id, env.id)).toEqual(['Guest checkout']);
  });

  it('approve with scope all updates every impacted case script, at each case step index', async () => {
    const { db, env, a, b, other, propose } = await setup();
    const p = await propose();
    const approved = await repos.healProposals.approve(db, p.id, { scope: 'all', userId: 'u1' });
    expect(approved).toMatchObject({ status: 'approved', approvedLive: 'u1' });
    expect(await nameOf(db, a.id, env.id)).toEqual(['Checkout as guest']);
    const scriptB = await repos.learnedScripts.getFor(db, b.id, env.id);
    expect(scriptB?.actions.map((x) => [x.stepIndex, x.locators[0]?.name])).toEqual([[2, 'Checkout as guest']]);
    expect(scriptB?.health).toMatchObject({ healCount: 1, pendingProposals: 0 });
    expect(await nameOf(db, other.id, env.id)).toEqual(['Guest checkout']);
    await expect(repos.healProposals.approve(db, p.id)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('approve with scope case only updates the proposal case', async () => {
    const { db, env, a, b, propose } = await setup();
    const p = await propose();
    await repos.healProposals.approve(db, p.id, { scope: 'case' });
    expect(await nameOf(db, a.id, env.id)).toEqual(['Checkout as guest']);
    expect(await nameOf(db, b.id, env.id)).toEqual(['Guest checkout']);
  });

  it('reject leaves scripts unchanged', async () => {
    const { db, project, env, a, b, scripts, propose } = await setup();
    const p = await propose();
    expect((await repos.healProposals.reject(db, p.id)).status).toBe('rejected');
    expect((await repos.learnedScripts.getFor(db, a.id, env.id))?.actions).toEqual(scripts.a.actions);
    expect((await repos.learnedScripts.getFor(db, b.id, env.id))?.actions).toEqual(scripts.b.actions);
    expect((await repos.learnedScripts.getFor(db, a.id, env.id))?.health.pendingProposals).toBe(0);
    expect(await repos.reviews.list(db, { projectId: project.id, status: 'rejected' })).toHaveLength(1);
    await expect(repos.healProposals.reject(db, 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('applies immediately to its own case when the project sets autoApplyHeals', async () => {
    const { db, project, env, a, b, propose } = await setup();
    await repos.projects.update(db, project.id, { autoApplyHeals: true });
    const p = await propose();
    expect(p.status).toBe('approved');
    expect(await nameOf(db, a.id, env.id)).toEqual(['Checkout as guest']);
    expect(await nameOf(db, b.id, env.id)).toEqual(['Guest checkout']);
  });
});
