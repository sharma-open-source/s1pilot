import { newId } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { caseInput, makeProject, memoryDb } from '../test-utils.js';

import { repos } from './index.js';

async function setup() {
  const db = memoryDb();
  const project = await makeProject(db);
  const env = await repos.environments.create(db, {
    id: newId(), projectId: project.id, name: 'dev', baseUrl: 'http://localhost:3000',
  });
  const testCase = await repos.cases.create(db, project.id, caseInput());
  return { db, project, env, testCase };
}

describe('suites repo', () => {
  it('nests, orders, updates and cascades to sub-suites', async () => {
    const { db, project } = await setup();
    const parent = await repos.suites.create(db, { id: newId(), projectId: project.id, name: 'Parent', position: 1 });
    const child = await repos.suites.create(db, { id: newId(), projectId: project.id, parentId: parent.id, name: 'Child' });
    const first = await repos.suites.create(db, { id: newId(), projectId: project.id, name: 'First', position: 0 });
    expect((await repos.suites.listByProject(db, project.id)).map((s) => s.name)).toEqual(['Child', 'First', 'Parent']);
    expect(child.parentId).toBe(parent.id);
    expect((await repos.suites.update(db, child.id, { parentId: undefined, name: 'Moved' })).name).toBe('Moved');
    await repos.suites.delete(db, parent.id);
    expect(await repos.suites.get(db, first.id)).toBeDefined();
  });

  it('assigns cases to suites and detaches them when the suite is deleted', async () => {
    const { db, project } = await setup();
    const suite = await repos.suites.create(db, { id: newId(), projectId: project.id, name: 'S' });
    const created = await repos.cases.create(db, project.id, { ...caseInput(), suiteId: suite.id });
    expect(created.suiteId).toBe(suite.id);
    expect((await repos.cases.list(db, { projectId: project.id, suiteId: suite.id }))).toHaveLength(1);
    await repos.suites.delete(db, suite.id);
    expect((await repos.cases.get(db, created.id))?.suiteId).toBeUndefined();
  });
});

describe('sharedSteps repo', () => {
  it('round-trips, lists and updates', async () => {
    const { db, project } = await setup();
    const created = await repos.sharedSteps.create(db, {
      id: newId(), projectId: project.id, name: 'Log in as {role}', params: ['role'],
      steps: [{ action: 'Log in as {role}', assert: [{ type: 'urlMatches', pattern: '/home' }] }],
    });
    expect((await repos.sharedSteps.get(db, created.id))?.steps[0]?.assert).toHaveLength(1);
    await repos.sharedSteps.update(db, created.id, { name: 'Sign in' });
    expect((await repos.sharedSteps.listByProject(db, project.id)).map((s) => s.name)).toEqual(['Sign in']);
    await repos.sharedSteps.delete(db, created.id);
    expect(await repos.sharedSteps.get(db, created.id)).toBeUndefined();
  });
});

describe('learnedScripts repo', () => {
  it('upserts one script per case and environment', async () => {
    const { db, env, testCase } = await setup();
    const action = {
      stepIndex: 0, subIndex: 0, action: 'click' as const, fingerprint: 'fp1', fromRunId: 'r1',
      locators: [{ kind: 'role' as const, value: 'button', name: 'Buy' }],
    };
    const first = await repos.learnedScripts.upsert(db, {
      id: newId(), caseId: testCase.id, caseVersion: 1, environmentId: env.id, createdFromRunId: 'r1', actions: [action],
    });
    const second = await repos.learnedScripts.upsert(db, {
      id: newId(), caseId: testCase.id, caseVersion: 2, environmentId: env.id, createdFromRunId: 'r2',
      actions: [action, { ...action, stepIndex: 1 }], health: { healCount: 1, pendingProposals: 0 },
    });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ caseVersion: 2, createdFromRunId: 'r2' });
    expect(second.actions).toHaveLength(2);
    expect(second.health.healCount).toBe(1);
    expect(await repos.learnedScripts.listByCase(db, testCase.id)).toHaveLength(1);
    expect((await repos.learnedScripts.get(db, first.id))?.actions[0]?.locators[0]?.name).toBe('Buy');
  });
});

describe('plans repo', () => {
  it('round-trips selection, matrix and checks', async () => {
    const { db, project, env } = await setup();
    const plan = await repos.plans.create(db, {
      id: newId(), projectId: project.id, name: 'Smoke',
      selection: { kind: 'query', query: 'tags:smoke' },
      matrix: [{ environmentId: env.id, browser: 'firefox', device: 'iPhone 13' }],
      checks: { a11y: true },
    });
    expect(plan).toMatchObject({ retries: 0, mode: 'replay-heal', selection: { kind: 'query' } });
    expect(plan.checks).toEqual({ a11y: true, consoleErrors: false, visual: false, video: false });
    const updated = await repos.plans.update(db, plan.id, { retries: 2, schedule: '0 2 * * *' });
    expect(updated).toMatchObject({ retries: 2, schedule: '0 2 * * *' });
    expect(await repos.plans.listByProject(db, project.id)).toHaveLength(1);
    await repos.plans.delete(db, plan.id);
    expect(await repos.plans.get(db, plan.id)).toBeUndefined();
  });
});

describe('runs and results repos', () => {
  it('stores a run with case results, steps, decisions and evidence', async () => {
    const { db, project, testCase } = await setup();
    const run = await repos.runs.create(db, { id: newId(), projectId: project.id, trigger: 'ci', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' });
    const updated = await repos.runs.update(db, run.id, { status: 'finished', summary: { passed: 1 } });
    expect(updated).toMatchObject({ status: 'finished', summary: { passed: 1, failed: 0 } });
    expect((await repos.runs.listByProject(db, project.id)).map((r) => r.id)).toEqual([run.id]);

    const caseResult = await repos.results.createCase(db, {
      id: newId(), runId: run.id, caseId: testCase.id, caseVersion: 1, verdict: 'needs-review', confidence: 0.55, durationMs: 120, mode: 'healed',
    });
    expect((await repos.results.updateCase(db, caseResult.id, { verdict: 'passed' })).verdict).toBe('passed');

    const stepId = newId();
    await repos.results.addStep(db, {
      id: stepId, caseResultId: caseResult.id, stepIndex: 1, status: 'passed', latencyMs: 30,
      decisions: [
        { questionId: 'next_action', options: ['e1', 'e2'], probabilities: { e1: 0.8, e2: 0.2 }, chosen: 'e1', confidence: 0.8, model: 'mock', latencyMs: 12 },
        { questionId: 'step_done', options: ['yes', 'no'], probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9, model: 'mock', latencyMs: 8, escalatedTo: 'system2' },
      ],
      assertions: [{ assertion: 'ai', verdict: 'pass', probability: 0.93 }],
      evidence: [{ kind: 'screenshot', artifactId: 'a1' }, { kind: 'trace', artifactId: 'a2' }],
    });
    await repos.results.addStep(db, { id: newId(), caseResultId: caseResult.id, stepIndex: 0, status: 'passed' });

    const steps = await repos.results.listSteps(db, caseResult.id);
    expect(steps.map((s) => s.stepIndex)).toEqual([0, 1]);
    const full = steps[1];
    expect(full?.decisions.map((d) => d.questionId)).toEqual(['next_action', 'step_done']);
    expect(full?.decisions[1]?.escalatedTo).toBe('system2');
    expect(full?.evidence.map((e) => e.kind)).toEqual(['screenshot', 'trace']);
    expect(full?.assertions[0]?.probability).toBe(0.93);
    expect(await repos.results.listCases(db, run.id)).toHaveLength(1);
  });
});

describe('defects repo', () => {
  it('stores external refs and links to results', async () => {
    const { db, project, testCase } = await setup();
    const run = await repos.runs.create(db, { id: newId(), projectId: project.id, trigger: 'manual', status: 'finished' });
    const result = await repos.results.createCase(db, {
      id: newId(), runId: run.id, caseId: testCase.id, caseVersion: 1, verdict: 'failed', durationMs: 1, mode: 'replay',
    });
    const defect = await repos.defects.create(db, {
      id: newId(), projectId: project.id, title: 'Cart broken', severity: 'S1',
      external: { provider: 'jira', id: 'SHOP-9', url: 'https://jira.example.com/SHOP-9' },
      linkedResultIds: [result.id],
    });
    expect(defect).toMatchObject({ status: 'open', linkedResultIds: [result.id], external: { provider: 'jira', id: 'SHOP-9' } });
    await repos.defects.link(db, defect.id, result.id);
    expect((await repos.defects.update(db, defect.id, { status: 'closed', external: undefined })).external).toBeUndefined();
    expect((await repos.defects.get(db, defect.id))?.linkedResultIds).toEqual([result.id]);
    expect(await repos.defects.listByProject(db, project.id)).toHaveLength(1);
  });
});

describe('reviews repo', () => {
  it('manages review items and heal proposals', async () => {
    const { db, project, env, testCase } = await setup();
    const item = await repos.reviews.create(db, { id: newId(), projectId: project.id, kind: 'verdict', refId: 'cr1' });
    expect(item.status).toBe('pending');
    expect(await repos.reviews.list(db, { projectId: project.id, status: 'pending' })).toHaveLength(1);
    const resolved = await repos.reviews.resolve(db, item.id, 'approved', 'looks right');
    expect(resolved).toMatchObject({ status: 'approved', note: 'looks right' });
    expect(resolved.resolvedAt).toBeDefined();
    expect(await repos.reviews.list(db, { projectId: project.id, status: 'pending' })).toHaveLength(0);

    const script = await repos.learnedScripts.upsert(db, {
      id: newId(), caseId: testCase.id, caseVersion: 1, environmentId: env.id, createdFromRunId: 'r1', actions: [],
    });
    const proposal = await repos.reviews.createHealProposal(db, {
      id: newId(), learnedScriptId: script.id, runId: 'r2', stepIndex: 0,
      actions: [{ stepIndex: 0, subIndex: 0, action: 'click', fingerprint: 'f', fromRunId: 'r2', locators: [{ kind: 'text', value: 'Buy now' }] }],
    });
    expect(await repos.reviews.listHealProposals(db, script.id, 'pending')).toHaveLength(1);
    await repos.reviews.resolveHealProposal(db, proposal.id, 'rejected');
    expect(await repos.reviews.listHealProposals(db, script.id, 'pending')).toHaveLength(0);
    await expect(repos.reviews.resolve(db, 'nope', 'approved')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('settings repo', () => {
  it('gets, sets, overwrites and deletes JSON values', async () => {
    const db = memoryDb();
    expect(await repos.settings.get(db, 'workspace.models')).toBeUndefined();
    await repos.settings.set(db, 'workspace.models', { system1: 'mock' });
    await repos.settings.set(db, 'workspace.models', { system1: 'decide', n: [1, 2] });
    expect(await repos.settings.get(db, 'workspace.models')).toEqual({ system1: 'decide', n: [1, 2] });
    await repos.settings.delete(db, 'workspace.models');
    expect(await repos.settings.get(db, 'workspace.models')).toBeUndefined();
  });
});
