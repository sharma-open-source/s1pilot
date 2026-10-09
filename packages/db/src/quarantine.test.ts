import { newId, type Verdict } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { createSqliteJobQueue } from './queue.js';
import { finalAttempts, repos } from './repos/index.js';
import { caseInput, makeProject, memoryDb } from './test-utils.js';

describe('quarantine and flakiness on cases', () => {
  it('quarantines with a reason, lifts it, and lists flaky cases by score', async () => {
    const db = memoryDb();
    const project = await makeProject(db);
    const a = await repos.cases.create(db, project.id, caseInput('A'));
    const b = await repos.cases.create(db, project.id, caseInput('B'));

    const q = await repos.cases.setQuarantine(db, a.id, 'login is unstable');
    expect(q).toMatchObject({ quarantined: true, quarantineReason: 'login is unstable', version: a.version });
    expect(q.quarantinedAt).toBeDefined();
    expect(await repos.cases.quarantinedIds(db, project.id)).toEqual([a.id]);
    // Editing the case keeps the quarantine.
    expect((await repos.cases.update(db, a.id, { title: 'A2' })).quarantined).toBe(true);
    const lifted = await repos.cases.setQuarantine(db, a.id, null);
    expect(lifted.quarantined).toBe(false);
    expect(lifted.quarantineReason).toBeUndefined();
    expect(await repos.cases.quarantinedIds(db, project.id)).toEqual([]);

    await repos.cases.setFlakiness(db, a.id, 0.25);
    await repos.cases.setFlakiness(db, b.id, 0.5);
    expect((await repos.cases.listFlaky(db, project.id)).map((c) => c.title)).toEqual(['B', 'A2']);
    expect(await repos.cases.listFlaky(db, project.id, 1)).toHaveLength(1);
  });
});

describe('final attempts', () => {
  it('keeps the last attempt per case, environment and browser', () => {
    const rows = [
      { caseId: 'c', environmentId: 'e', browser: 'chromium', attempt: 1, v: 'failed' },
      { caseId: 'c', environmentId: 'e', browser: 'chromium', attempt: 2, v: 'flaky' },
      { caseId: 'c', environmentId: 'e', browser: 'firefox', attempt: 1, v: 'passed' },
    ];
    expect(finalAttempts(rows).map((r) => r.v)).toEqual(['flaky', 'passed']);
  });

  it('feeds per-target verdict histories, oldest first', async () => {
    const db = memoryDb();
    const project = await makeProject(db);
    const c = await repos.cases.create(db, project.id, caseInput());
    const history: Verdict[][] = [['failed', 'passed'], ['passed']];
    for (const [i, attempts] of history.entries()) {
      const run = await repos.runs.create(db, {
        id: newId(),
        projectId: project.id,
        trigger: 'manual',
        status: 'passed',
        startedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
      for (const [n, verdict] of attempts.entries()) {
        await repos.results.createCase(db, {
          id: newId(),
          runId: run.id,
          caseId: c.id,
          caseVersion: 1,
          environmentId: 'env1',
          browser: 'chromium',
          attempt: n + 1,
          verdict,
          durationMs: 1,
          mode: 'explore',
        });
      }
    }
    const byTarget = await repos.results.finalVerdictsByTarget(db, c.id);
    expect(byTarget.get('env1|chromium')).toEqual(['passed', 'passed']);
  });
});

describe('queue per-run exclusion', () => {
  it('skips excluded runs when claiming', async () => {
    const queue = createSqliteJobQueue(memoryDb());
    await queue.enqueue({ type: 'run-case', runId: 'r1', payload: {} });
    const second = await queue.enqueue({ type: 'run-case', runId: 'r2', payload: {} });
    expect((await queue.claim('w', { excludeRunIds: ['r1'] }))?.id).toBe(second.id);
    expect(await queue.claim('w', { excludeRunIds: ['r1'] })).toBeUndefined();
  });
});
