import { newId } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { caseInput, makeProject, memoryDb } from '../test-utils.js';

import { repos } from './index.js';

describe('projects repo', () => {
  it('creates with defaults, reads by id and key, lists and updates', async () => {
    const db = memoryDb();
    const project = await makeProject(db);
    expect(project).toMatchObject({ key: 'SHOP', retentionDays: 30 });
    expect(project.dataPolicy.sendScreenshots).toBe('ambiguous');
    expect((await repos.projects.getByKey(db, 'SHOP'))?.id).toBe(project.id);
    expect(await repos.projects.get(db, 'nope')).toBeUndefined();

    const updated = await repos.projects.update(db, project.id, {
      name: 'Renamed',
      retentionDays: 7,
      modelSettings: {
        system1: { adapter: 'mock', model: 'm' },
        thresholds: { act: 0.9, pass: 0.8, fail: 0.2, escalate: 0.5 },
        dualOrderSensitive: true,
      },
    });
    expect(updated).toMatchObject({ name: 'Renamed', retentionDays: 7, key: 'SHOP' });
    expect(updated.modelSettings?.dualOrderSensitive).toBe(true);
    expect(await repos.projects.list(db)).toHaveLength(1);
  });

  it('rejects duplicate keys and invalid input', async () => {
    const db = memoryDb();
    await makeProject(db);
    await expect(makeProject(db)).rejects.toThrow();
    await expect(repos.projects.create(db, { id: newId(), name: 'x', key: 'bad' })).rejects.toThrow(/Project key/);
  });

  it('cascades deletes to all children', async () => {
    const db = memoryDb();
    const project = await makeProject(db);
    const env = await repos.environments.create(db, {
      id: newId(), projectId: project.id, name: 'dev', baseUrl: 'http://localhost:3000',
      variables: [{ key: 'K', value: 'v' }],
    });
    const suite = await repos.suites.create(db, { id: newId(), projectId: project.id, name: 'S' });
    const child = await repos.suites.create(db, { id: newId(), projectId: project.id, parentId: suite.id, name: 'C' });
    const testCase = await repos.cases.create(db, project.id, caseInput());
    await repos.cases.update(db, testCase.id, { title: 'v2' });
    await repos.sharedSteps.create(db, { id: newId(), projectId: project.id, name: 'flow', steps: [{ action: 'x' }] });
    const run = await repos.runs.create(db, { id: newId(), projectId: project.id, trigger: 'manual', status: 'running' });
    const caseResult = await repos.results.createCase(db, {
      id: newId(), runId: run.id, caseId: testCase.id, caseVersion: 1, verdict: 'passed', durationMs: 5, mode: 'explore',
    });
    await repos.results.addStep(db, { id: newId(), caseResultId: caseResult.id, stepIndex: 0, status: 'passed' });
    await repos.learnedScripts.upsert(db, {
      id: newId(), caseId: testCase.id, caseVersion: 1, environmentId: env.id, createdFromRunId: run.id, actions: [],
    });
    const defect = await repos.defects.create(db, {
      id: newId(), projectId: project.id, title: 'd', severity: 'S3', linkedResultIds: [caseResult.id],
    });
    await repos.reviews.create(db, { id: newId(), projectId: project.id, kind: 'verdict', refId: caseResult.id });

    await repos.projects.delete(db, project.id);

    const count = (table: string) =>
      (db.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
    for (const table of [
      'projects', 'environments', 'variables', 'suites', 'test_cases', 'test_case_versions', 'shared_steps',
      'test_runs', 'case_results', 'step_results', 'learned_scripts', 'defects', 'defect_results', 'review_items',
    ]) {
      expect(count(table), table).toBe(0);
    }
    expect(await repos.suites.get(db, child.id)).toBeUndefined();
    expect(await repos.defects.get(db, defect.id)).toBeUndefined();
  });
});

describe('environments repo', () => {
  const base = { projectId: '', name: 'staging', baseUrl: 'https://staging.example.com' };

  it('stores secret variables only as ciphertext and never returns them', async () => {
    const db = memoryDb();
    const project = await makeProject(db);
    const env = await repos.environments.create(db, {
      ...base, id: newId(), projectId: project.id,
      variables: [
        { key: 'PASSWORD', value: 'hunter2-plaintext', secret: true },
        { key: 'REGION', value: 'eu' },
        { key: 'TOKEN', secret: true, source: 'env', envVar: 'SHOP_TOKEN' },
      ],
    });

    expect(env.variables).toEqual([
      { key: 'PASSWORD', value: undefined, secret: true, source: 'inline', envVar: undefined },
      { key: 'REGION', value: 'eu', secret: false, source: 'inline', envVar: undefined },
      { key: 'TOKEN', value: undefined, secret: true, source: 'env', envVar: 'SHOP_TOKEN' },
    ]);

    const rows = db.sqlite.prepare('select * from variables').all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain('hunter2-plaintext');
    const password = rows.find((r) => r['key'] === 'PASSWORD');
    expect(password).toMatchObject({ value: null, secret: 1 });
    expect(String(password?.['secret_ciphertext'])).toMatch(/^enc:/);

    expect(await repos.environments.getSecret(db, env.id, 'PASSWORD')).toBe('hunter2-plaintext');
    expect(await repos.environments.getSecret(db, env.id, 'REGION')).toBeUndefined();
  });

  it('keeps an existing secret when variables are replaced without a new value', async () => {
    const db = memoryDb();
    const project = await makeProject(db);
    const env = await repos.environments.create(db, {
      ...base, id: newId(), projectId: project.id,
      variables: [{ key: 'PASSWORD', value: 'first', secret: true }],
    });
    await repos.environments.update(db, env.id, { variables: [{ key: 'PASSWORD', secret: true, source: 'inline' }, { key: 'A', value: '1' }] });
    expect(await repos.environments.getSecret(db, env.id, 'PASSWORD')).toBe('first');
    await repos.environments.update(db, env.id, { variables: [{ key: 'PASSWORD', value: 'second', secret: true, source: 'inline' }] });
    expect(await repos.environments.getSecret(db, env.id, 'PASSWORD')).toBe('second');
    expect((await repos.environments.get(db, env.id))?.variables).toHaveLength(1);
  });

  it('applies defaults, lists by project and updates fields', async () => {
    const db = memoryDb();
    const project = await makeProject(db);
    const env = await repos.environments.create(db, { ...base, id: newId(), projectId: project.id });
    expect(env).toMatchObject({ readOnly: false, browsers: [{ browser: 'chromium' }], requireApprovalFor: ['pay', 'delete', 'send'] });
    const updated = await repos.environments.update(db, env.id, { readOnly: true, allowDomains: ['example.com'] });
    expect(updated).toMatchObject({ readOnly: true, allowDomains: ['example.com'] });
    expect(await repos.environments.listByProject(db, project.id)).toHaveLength(1);
    await repos.environments.delete(db, env.id);
    expect(await repos.environments.get(db, env.id)).toBeUndefined();
  });

  it('refuses to store secrets when no crypto is configured', async () => {
    const { openDb } = await import('../db.js');
    const db = openDb({ url: ':memory:' });
    const project = await makeProject(db);
    await expect(
      repos.environments.create(db, { ...base, id: newId(), projectId: project.id, variables: [{ key: 'P', value: 'x', secret: true }] }),
    ).rejects.toThrow(/No SecretCrypto/);
  });
});
