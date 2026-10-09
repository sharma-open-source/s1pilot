import { createVault, openDb, repos, type Db } from '@s1pilot/db';
import { createLogger } from '@s1pilot/domain/logger';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../config.js';
import { createContext } from '../context.js';
import { appRouter, createCallerFactory } from '../router.js';

import { expectedCalibrationError, rangeDays } from './analytics.js';

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

const DAY = 86_400_000;
const VERDICTS = ['passed', 'passed', 'passed', 'passed', 'needs-review', 'failed', 'flaky'] as const;
const MODES = ['replay', 'replay', 'healed', 'explore'] as const;

interface SeedOptions {
  /** Case results to create in total. */
  results: number;
  cases: number;
  runs: number;
  days: number;
}

/** Inserts runs/results/steps/decisions with raw SQL (fast) for a project with 2 environments and 3 suites. */
async function seed(api: ReturnType<typeof makeCaller>, db: Db, opts: SeedOptions) {
  const project = await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
  const staging = await api.environments.create({ projectKey: 'SHOP', name: 'staging', baseUrl: 'http://s.test' });
  const dev = (await api.environments.list({ projectKey: 'SHOP' })).find((e) => e.name === 'dev') ?? staging;
  const suites = [] as string[];
  for (const name of ['Auth', 'Search', 'Checkout']) suites.push((await api.suites.create({ projectKey: 'SHOP', name })).id);
  const caseIds: string[] = [];
  for (let i = 0; i < opts.cases; i += 1) {
    const c = await api.cases.create({ projectKey: 'SHOP', title: `Case ${i}`, suiteId: suites[i % 3] as string, steps: [{ action: 'Open' }] });
    caseIds.push(c.id);
  }
  const now = Date.now();
  const sql = db.sqlite;
  const insRun = sql.prepare(
    `INSERT INTO test_runs (id, project_id, trigger, status, started_at, finished_at, summary) VALUES (?, ?, 'manual', 'failed', ?, ?, '{}')`,
  );
  const insCase = sql.prepare(
    `INSERT INTO case_results (id, run_id, case_id, case_version, environment_id, browser, attempt, verdict, duration_ms, mode, escalations)
     VALUES (?, ?, ?, 1, ?, 'chromium', 1, ?, ?, ?, 0)`,
  );
  const insStep = sql.prepare(`INSERT INTO step_results (id, case_result_id, step_index, status, assertions, latency_ms) VALUES (?, ?, 0, 'passed', '[]', 10)`);
  const insDec = sql.prepare(
    `INSERT INTO decision_records (id, step_result_id, position, question_id, options, probabilities, chosen, confidence, model, latency_ms, escalated_to)
     VALUES (?, ?, 0, 'q', '[]', '{}', 'a', 0.9, 'clef', ?, ?)`,
  );
  const perRun = Math.ceil(opts.results / opts.runs);
  let n = 0;
  sql.transaction(() => {
    for (let r = 0; r < opts.runs; r += 1) {
      const started = new Date(now - (r % opts.days) * DAY - 3_600_000).toISOString();
      insRun.run(`run${r}`, project.id, started, started);
      for (let k = 0; k < perRun && n < opts.results; k += 1, n += 1) {
        const id = `cr${n}`;
        insCase.run(id, `run${r}`, caseIds[n % caseIds.length], r % 2 === 0 ? staging.id : dev.id, VERDICTS[n % VERDICTS.length], 1000 + (n % 97) * 100, MODES[n % MODES.length]);
        insStep.run(`st${n}`, id);
        insDec.run(`d${n}`, `st${n}`, 100 + (n % 50) * 10, n % 10 === 0 ? 'system2' : null);
      }
    }
  })();
  await repos.analytics.rebuild(db, project.id);
  return { project, staging, dev, suites, caseIds };
}

describe('pure helpers', () => {
  it('covers the range ending today', () => {
    const days = rangeDays(7, new Date('2026-10-09T12:00:00Z'));
    expect(days).toHaveLength(7);
    expect(days[0]).toBe('2026-10-03');
    expect(days.at(-1)).toBe('2026-10-09');
  });

  it('computes ECE over confidence bins', () => {
    expect(expectedCalibrationError([])).toBeNull();
    // 10 samples at 0.9 confidence, 7 correct: |0.7 - 0.9| = 0.2
    const s = Array.from({ length: 10 }, (_, i) => ({ confidence: 0.9, correct: i < 7 }));
    expect(expectedCalibrationError(s)).toBe(0.2);
    expect(expectedCalibrationError(Array.from({ length: 10 }, (_, i) => ({ confidence: 0.95, correct: i < 10 })))).toBe(0.05);
  });
});

describe('analytics router on 30 days of seeded data', () => {
  it('renders every series and filters change the data', async () => {
    const { api, db } = await setup();
    const { suites, caseIds, project, staging } = await seed(api, db, { results: 700, cases: 14, runs: 70, days: 30 });
    const base = { projectKey: 'SHOP', range: 30 } as const;

    const series = await api.analytics.passRateSeries(base);
    expect(series.environments).toEqual(['dev', 'staging']);
    expect(series.points).toHaveLength(30);
    expect(series.total).toBe(700);
    expect(series.points.some((p) => p.rates['staging'] !== null)).toBe(true);

    const bySuite = await api.analytics.resultsBySuite(base);
    expect(bySuite.map((s) => s.suite)).toEqual(['Auth', 'Checkout', 'Search']);
    expect(bySuite.reduce((a, s) => a + s.total, 0)).toBe(700);
    expect(bySuite.reduce((a, s) => a + s.passed, 0)).toBe(400);
    expect(bySuite.reduce((a, s) => a + s.review, 0)).toBe(100);
    expect(bySuite.reduce((a, s) => a + s.failed, 0)).toBe(200);
    expect(bySuite.reduce((a, s) => a + s.flaky, 0)).toBe(100);

    // Filters: environment, suite and range change the numbers.
    const stagingOnly = await api.analytics.resultsBySuite({ ...base, environment: 'staging' });
    expect(stagingOnly.reduce((a, s) => a + s.total, 0)).toBe(350);
    expect((await api.analytics.passRateSeries({ ...base, environment: staging.id })).environments).toEqual(['staging']);
    const oneSuite = await api.analytics.resultsBySuite({ ...base, suite: suites[0] as string });
    expect(oneSuite).toHaveLength(1);
    expect(oneSuite[0]?.total).toBeLessThan(700);
    const week = await api.analytics.resultsBySuite({ ...base, range: 7 });
    expect(week.reduce((a, s) => a + s.total, 0)).toBeLessThan(700);
    expect((await api.analytics.resultsBySuite({ ...base, environment: 'nope' }))).toEqual([]);

    const mix = await api.analytics.modeMix(base);
    expect(mix.replay + mix.heal + mix.explore).toBe(100);
    expect(mix.replay).toBe(50);

    // Flaky top: only cases with a score, highest first.
    await repos.cases.setFlakiness(db, caseIds[0] as string, 0.2);
    await repos.cases.setFlakiness(db, caseIds[1] as string, 0.6);
    await repos.cases.setQuarantine(db, caseIds[1] as string, 'flaky');
    const flaky = await api.analytics.flakyTop(base);
    expect(flaky.map((f) => [f.flakiness, f.quarantined])).toEqual([[0.6, true], [0.2, false]]);

    const slow = await api.analytics.slowestTop(base);
    expect(slow).toHaveLength(10);
    expect(slow.map((x) => x.avgDurationMs)).toEqual([...slow.map((x) => x.avgDurationMs)].sort((a, b) => b - a));
    expect(['replay', 'heal', 'explore']).toContain(slow[0]?.mode);

    const ai = await api.analytics.aiQuality(base);
    expect(ai.decisions).toBe(700);
    expect(ai.escalationRate).toBe(10);
    expect(ai.needsReviewRate).toBe(14.3);
    expect(ai.latencyP50).toBeGreaterThan(100);
    expect(ai.latencyP95).toBeGreaterThan(ai.latencyP50 as number);
    expect(ai).toMatchObject({ overrideRate: null, ece: null, healSuccessRate: null, reviewedDecisions: 0, lastTunedAt: null });

    // Reviewed decisions feed override rate and ECE: 10 reviews at p=0.9, 7 agreed.
    for (let i = 0; i < 10; i += 1) {
      await repos.reviews.create(db, {
        id: `rv${i}`,
        projectId: project.id,
        kind: 'verdict',
        refId: `x${i}`,
        status: 'approved',
        resolvedAt: new Date().toISOString(),
        outcome: { pTrue: 0.9, humanVerdict: i < 7 ? 'passed' : 'failed', questionType: 'noul', optionCount: 2, model: 'clef' },
      });
    }
    const reviewed = await api.analytics.aiQuality(base);
    expect(reviewed).toMatchObject({ overrideRate: 30, ece: 0.2, reviewedDecisions: 10 });
  });

  it('keeps the rollup current when a run finishes or a verdict is overridden', async () => {
    const { api, db } = await setup();
    const { project, caseIds } = await seed(api, db, { results: 7, cases: 7, runs: 1, days: 1 });
    const q = { projectKey: 'SHOP', range: 7 } as const;
    expect((await api.analytics.resultsBySuite(q)).reduce((a, s) => a + s.passed, 0)).toBe(4);
    await repos.results.updateCase(db, 'cr5', { verdict: 'passed' });
    await repos.analytics.refreshForRun(db, project.id, (await repos.runs.get(db, 'run0'))?.startedAt);
    expect((await api.analytics.resultsBySuite(q)).reduce((a, s) => a + s.passed, 0)).toBe(5);
    expect(caseIds).toHaveLength(7);
  });

  it('reports release readiness with live exit criteria and requirement coverage', async () => {
    const { api, db } = await setup();
    const { project, staging, caseIds } = await seed(api, db, { results: 7, cases: 7, runs: 1, days: 1 });
    expect(await api.analytics.releaseReadiness({ projectKey: 'SHOP' })).toEqual([]);
    const plan = await api.plans.create({
      projectKey: 'SHOP',
      name: 'Release 1.4',
      release: '1.4',
      selection: { kind: 'list', caseIds },
      matrix: [{ environmentId: staging.id, browser: 'chromium' }],
      exitCriteria: [{ kind: 'pass-rate', params: { minPct: 90, priority: ['P0', 'P1', 'P2', 'P3'] } }, { kind: 'review-queue-empty', params: {} }],
    });
    expect((await api.analytics.releaseReadiness({ projectKey: 'SHOP' }))[0]).toMatchObject({ plan: 'Release 1.4', run: null, criteria: null });
    await repos.runs.update(db, 'run0', { planId: plan.id });
    const [ready] = await api.analytics.releaseReadiness({ projectKey: 'SHOP', planId: plan.id });
    expect(ready?.run?.id).toBe('run0');
    expect(ready?.criteria).toMatchObject({ total: 2, allMet: false });
    expect(ready?.criteria?.met).toBeLessThan(2);

    const req = await api.requirements.create({ projectKey: 'SHOP', title: 'Guest checkout' });
    await api.requirements.create({ projectKey: 'SHOP', title: 'Orphan' });
    await api.requirements.link({ caseKey: (await repos.cases.get(db, caseIds[5] as string))?.key as string, reqKey: req.key });
    const cov = await api.analytics.coverage({ projectKey: 'SHOP' });
    expect(cov.find((c) => c.key === req.key)).toMatchObject({ status: 'failing', cases: [{ lastVerdict: 'failed' }] });
    expect(cov.find((c) => c.title === 'Orphan')).toMatchObject({ status: 'uncovered', cases: [] });
    void project;
  });

  it('is empty without data', async () => {
    const { api } = await setup();
    await api.projects.create({ name: 'Shop', key: 'SHOP', baseUrl: 'http://a.test' });
    expect(await api.analytics.passRateSeries({ projectKey: 'SHOP' })).toMatchObject({ environments: [], total: 0 });
    expect(await api.analytics.resultsBySuite({ projectKey: 'SHOP' })).toEqual([]);
    expect(await api.analytics.modeMix({ projectKey: 'SHOP' })).toEqual({ replay: 0, heal: 0, explore: 0 });
    expect(await api.analytics.aiQuality({ projectKey: 'SHOP' })).toMatchObject({ decisions: 0, escalationRate: null, latencyP50: null });
  });
});

describe('analytics performance', () => {
  it('answers every query in under 200 ms on 100k results', async () => {
    const { api, db } = await setup();
    await seed(api, db, { results: 100_000, cases: 2000, runs: 3000, days: 30 });
    const input = { projectKey: 'SHOP', range: 30 } as const;
    const queries: Array<[string, () => Promise<unknown>]> = [
      ['passRateSeries', () => api.analytics.passRateSeries(input)],
      ['resultsBySuite', () => api.analytics.resultsBySuite(input)],
      ['flakyTop', () => api.analytics.flakyTop(input)],
      ['slowestTop', () => api.analytics.slowestTop(input)],
      ['modeMix', () => api.analytics.modeMix(input)],
      ['aiQuality', () => api.analytics.aiQuality(input)],
      ['releaseReadiness', () => api.analytics.releaseReadiness({ projectKey: 'SHOP' })],
      ['coverage', () => api.analytics.coverage({ projectKey: 'SHOP' })],
    ];
    const slow: string[] = [];
    for (const [name, run] of queries) {
      const t0 = performance.now();
      await run();
      const ms = performance.now() - t0;
      if (ms >= 200) slow.push(`${name} ${Math.round(ms)} ms`);
    }
    expect(slow).toEqual([]);
  }, 120_000);
});
