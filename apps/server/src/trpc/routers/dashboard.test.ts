import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import { createContext } from '../context.js';
import { appRouter, createCallerFactory } from '../router.js';

import { displayStatusOf, toPercentages } from './dashboard.js';

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
  return { api: makeCaller(ctx), db };
}

afterEach(() => {
  dbs.splice(0).forEach((d) => d.close());
});

describe('pure helpers', () => {
  it('rounds percentages to exactly 100', () => {
    expect(toPercentages([1, 1, 1])).toEqual([34, 33, 33]);
    expect(toPercentages([6, 1.5, 2.5])).toEqual([60, 15, 25]);
    expect(toPercentages([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('maps run status and summary to a display status', () => {
    const s = { passed: 1, failed: 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 };
    expect(displayStatusOf('running', s)).toBe('running');
    expect(displayStatusOf('passed', s)).toBe('passed');
    expect(displayStatusOf('finished', { ...s, failed: 1 })).toBe('failed');
    expect(displayStatusOf('needs-review', s)).toBe('needs-review');
    expect(displayStatusOf('queued', s)).toBe('queued');
  });
});

describe('dashboard.summary and runs.recent', () => {
  it('is all zeros on an empty workspace', async () => {
    const { api } = await setup();
    expect(await api.dashboard.summary()).toEqual({
      passRate7d: null,
      passRateSeries: [null, null, null, null, null, null, null],
      runsToday: 0,
      runningNow: 0,
      needsReview: 0,
      flaky: 0,
      quarantined: 0,
      modeMix7d: { replay: 0, heal: 0, explore: 0 },
    });
    expect(await api.runs.recent({})).toEqual([]);
  });

  it('aggregates results, steps and runs', async () => {
    const { api, db } = await setup();
    const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
    const c = await api.cases.create({ projectKey: 'SHOP', title: 'A', steps: [{ action: 'Open' }, { action: 'Click' }] });
    const now = Date.now();
    const finished = await repos.runs.create(db, {
      id: 'r1',
      projectId: project.id,
      trigger: 'manual',
      status: 'failed',
      startedAt: new Date(now - 60_000).toISOString(),
      summary: { passed: 1, failed: 1, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 },
    });
    await repos.runs.create(db, {
      id: 'r2',
      projectId: project.id,
      trigger: 'manual',
      status: 'running',
      startedAt: new Date(now - 1_000).toISOString(),
    });
    const addResult = async (id: string, verdict: 'passed' | 'failed' | 'flaky', mode: 'replay' | 'healed' | 'explore', stepCount: number) => {
      await repos.results.createCase(db, { id, runId: finished.id, caseId: c.id, caseVersion: 1, verdict, durationMs: 1, mode });
      for (let i = 0; i < stepCount; i += 1) {
        await repos.results.addStep(db, { id: `${id}-s${i}`, caseResultId: id, stepIndex: i, status: 'passed' });
      }
    };
    await addResult('cr1', 'passed', 'replay', 3);
    await addResult('cr2', 'failed', 'explore', 1);
    await addResult('cr3', 'flaky', 'replay', 0);

    const s = await api.dashboard.summary();
    expect(s.passRate7d).toBe(33.3);
    expect(s.passRateSeries.at(-1)).toBe(33.3);
    expect(s.passRateSeries.slice(0, 6).every((v) => v === null)).toBe(true);
    expect(s.runsToday).toBeGreaterThanOrEqual(1);
    expect(s.runningNow).toBe(1);
    expect(s.flaky).toBe(1);
    expect(s.modeMix7d).toEqual({ replay: 75, heal: 0, explore: 25 });

    const recent = await api.runs.recent({ limit: 8 });
    expect(recent.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(recent[0]).toMatchObject({ status: 'running', projectKey: 'SHOP', title: 'Manual run · SHOP' });
    expect(recent[1]).toMatchObject({ status: 'failed' });
    expect(await api.runs.recent({ limit: 1 })).toHaveLength(1);
  });
});
