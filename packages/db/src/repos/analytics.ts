import type { Db } from '../db.js';

/** Upper edges (ms) of the decision-latency histogram buckets; one extra overflow bucket follows the last edge. */
export const LATENCY_EDGES_MS: readonly number[] = (() => {
  const edges: number[] = [];
  for (let e = 10; e < 120_000; e = Math.ceil(e * 1.2)) edges.push(e);
  return edges;
})();

/** Index of the histogram bucket a latency falls into. */
export function latencyBucket(ms: number): number {
  let lo = 0;
  let hi = LATENCY_EDGES_MS.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((LATENCY_EDGES_MS[mid] as number) < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Percentile (0..1) of a histogram, linearly interpolated inside the bucket; `null` when empty. */
export function histogramPercentile(hist: readonly number[], q: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const target = q * total;
  let seen = 0;
  for (let i = 0; i < hist.length; i += 1) {
    const n = hist[i] ?? 0;
    if (n > 0 && seen + n >= target) {
      const lower = i === 0 ? 0 : (LATENCY_EDGES_MS[i - 1] as number);
      const upper = LATENCY_EDGES_MS[i] ?? lower * 1.2;
      return Math.round(lower + ((target - seen) / n) * (upper - lower));
    }
    seen += n;
  }
  return null;
}

/** One rollup row (project x day x environment x suite). `''` ids mean "none". */
export interface AnalyticsDayRow {
  day: string;
  environmentId: string;
  suiteId: string;
  passed: number;
  review: number;
  failed: number;
  flaky: number;
  skipped: number;
  stepsReplay: number;
  stepsHeal: number;
  stepsExplore: number;
  decisions: number;
  escalated: number;
  latencyHist: number[];
}

/** Filter of rollup reads; `from`/`to` are inclusive `YYYY-MM-DD` UTC days. */
export interface AnalyticsFilter {
  from: string;
  to: string;
  environmentId?: string | undefined;
  suiteId?: string | undefined;
}

/** Latest attempt only (see `finalAttempts`): no later attempt of the same run x case x environment x browser. */
const FINAL_ATTEMPT = `NOT EXISTS (SELECT 1 FROM case_results c2 WHERE c2.run_id = c.run_id AND c2.case_id = c.case_id
  AND COALESCE(c2.environment_id, '') = COALESCE(c.environment_id, '') AND COALESCE(c2.browser, '') = COALESCE(c.browser, '') AND c2.attempt > c.attempt)`;
const TERMINAL = `r.status NOT IN ('queued', 'running', 'paused') AND r.started_at IS NOT NULL`;

interface Cell extends Omit<AnalyticsDayRow, 'day'> {
  key: string;
}

const emptyCell = (environmentId: string, suiteId: string): Cell => ({
  key: `${environmentId}\u0000${suiteId}`,
  environmentId,
  suiteId,
  passed: 0,
  review: 0,
  failed: 0,
  flaky: 0,
  skipped: 0,
  stepsReplay: 0,
  stepsHeal: 0,
  stepsExplore: 0,
  decisions: 0,
  escalated: 0,
  latencyHist: new Array<number>(LATENCY_EDGES_MS.length + 1).fill(0),
});

/**
 * Daily rollup of final case results for the analytics screens (S-057). The table `analytics_daily` is rebuilt
 * per project and UTC day when a run finishes (`refreshDay`) or a verdict is overridden, so reads are tiny
 * regardless of the number of results.
 */
export const analytics = {
  /** Recomputes the rollup rows of one project and UTC day (`YYYY-MM-DD`) from the result tables. */
  async refreshDay(db: Db, projectId: string, day: string): Promise<void> {
    const cells = new Map<string, Cell>();
    const cell = (env: string | null, suite: string | null): Cell => {
      const e = env ?? '';
      const s = suite ?? '';
      const k = `${e}\u0000${s}`;
      let c = cells.get(k);
      if (!c) {
        c = emptyCell(e, s);
        cells.set(k, c);
      }
      return c;
    };
    const base = `FROM case_results c JOIN test_runs r ON r.id = c.run_id JOIN test_cases tc ON tc.id = c.case_id
       WHERE r.project_id = ? AND substr(r.started_at, 1, 10) = ? AND ${TERMINAL} AND ${FINAL_ATTEMPT}`;

    const verdicts = db.sqlite
      .prepare(`SELECT c.environment_id AS env, tc.suite_id AS suite, c.verdict AS verdict, COUNT(*) AS n ${base} GROUP BY 1, 2, 3`)
      .all(projectId, day) as Array<{ env: string | null; suite: string | null; verdict: string; n: number }>;
    for (const v of verdicts) {
      const c = cell(v.env, v.suite);
      if (v.verdict === 'passed') c.passed += v.n;
      else if (v.verdict === 'needs-review') c.review += v.n;
      else if (v.verdict === 'skipped') c.skipped += v.n;
      else {
        c.failed += v.n;
        if (v.verdict === 'flaky') c.flaky += v.n;
      }
    }

    // Step results carry no mode of their own; a step counts toward the mode of its case result (as on the dashboard).
    const steps = db.sqlite
      .prepare(
        `SELECT c.environment_id AS env, tc.suite_id AS suite, c.mode AS mode, COUNT(s.id) AS n
           FROM step_results s JOIN case_results c ON c.id = s.case_result_id JOIN test_runs r ON r.id = c.run_id JOIN test_cases tc ON tc.id = c.case_id
          WHERE r.project_id = ? AND substr(r.started_at, 1, 10) = ? AND ${TERMINAL} AND c.mode != 'manual' AND ${FINAL_ATTEMPT}
          GROUP BY 1, 2, 3`,
      )
      .all(projectId, day) as Array<{ env: string | null; suite: string | null; mode: string; n: number }>;
    for (const s of steps) {
      const c = cell(s.env, s.suite);
      if (s.mode === 'replay') c.stepsReplay += s.n;
      else if (s.mode === 'healed') c.stepsHeal += s.n;
      else if (s.mode === 'explore') c.stepsExplore += s.n;
    }

    const decisions = db.sqlite
      .prepare(
        `SELECT c.environment_id AS env, tc.suite_id AS suite, d.latency_ms AS ms, d.escalated_to AS esc
           FROM decision_records d JOIN step_results s ON s.id = d.step_result_id JOIN case_results c ON c.id = s.case_result_id
                JOIN test_runs r ON r.id = c.run_id JOIN test_cases tc ON tc.id = c.case_id
          WHERE r.project_id = ? AND substr(r.started_at, 1, 10) = ? AND ${TERMINAL} AND ${FINAL_ATTEMPT}`,
      )
      .iterate(projectId, day) as Iterable<{ env: string | null; suite: string | null; ms: number; esc: string | null }>;
    for (const d of decisions) {
      const c = cell(d.env, d.suite);
      c.decisions += 1;
      if (d.esc) c.escalated += 1;
      const b = latencyBucket(d.ms);
      c.latencyHist[b] = (c.latencyHist[b] ?? 0) + 1;
    }

    const del = db.sqlite.prepare('DELETE FROM analytics_daily WHERE project_id = ? AND day = ?');
    const ins = db.sqlite.prepare(
      `INSERT INTO analytics_daily (project_id, day, environment_id, suite_id, passed, review, failed, flaky, skipped,
         steps_replay, steps_heal, steps_explore, decisions, escalated, latency_hist)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.sqlite.transaction(() => {
      del.run(projectId, day);
      for (const c of cells.values()) {
        ins.run(
          projectId, day, c.environmentId, c.suiteId, c.passed, c.review, c.failed, c.flaky, c.skipped,
          c.stepsReplay, c.stepsHeal, c.stepsExplore, c.decisions, c.escalated, JSON.stringify(c.latencyHist),
        );
      }
    })();
  },

  /** Refreshes the day a run started on (no-op for runs that have not started). */
  async refreshForRun(db: Db, projectId: string, startedAt: string | undefined): Promise<void> {
    if (startedAt) await this.refreshDay(db, projectId, startedAt.slice(0, 10));
  },

  /** Rebuilds every day of a project that has runs (used for imported or pre-S-057 data). */
  async rebuild(db: Db, projectId: string): Promise<void> {
    const days = db.sqlite
      .prepare('SELECT DISTINCT substr(started_at, 1, 10) AS day FROM test_runs WHERE project_id = ? AND started_at IS NOT NULL')
      .all(projectId) as Array<{ day: string }>;
    for (const { day } of days) await this.refreshDay(db, projectId, day);
  },

  /**
   * Makes sure the rollup covers the project's data: when the project has runs but no rollup rows at all (data
   * written before S-057 or by direct inserts) it is rebuilt once.
   */
  async ensure(db: Db, projectId: string): Promise<void> {
    const have = db.sqlite.prepare('SELECT 1 AS x FROM analytics_daily WHERE project_id = ? LIMIT 1').get(projectId);
    if (have) return;
    const runs = db.sqlite.prepare('SELECT 1 AS x FROM test_runs WHERE project_id = ? LIMIT 1').get(projectId);
    if (runs) await this.rebuild(db, projectId);
  },

  /** Rollup rows of the project within the filter, oldest day first. */
  async days(db: Db, projectId: string, f: AnalyticsFilter): Promise<AnalyticsDayRow[]> {
    const where = ['project_id = ?', 'day >= ?', 'day <= ?'];
    const params: unknown[] = [projectId, f.from, f.to];
    if (f.environmentId) {
      where.push('environment_id = ?');
      params.push(f.environmentId);
    }
    if (f.suiteId) {
      where.push('suite_id = ?');
      params.push(f.suiteId);
    }
    const rows = db.sqlite
      .prepare(
        `SELECT day, environment_id AS environmentId, suite_id AS suiteId, passed, review, failed, flaky, skipped,
                steps_replay AS stepsReplay, steps_heal AS stepsHeal, steps_explore AS stepsExplore, decisions, escalated,
                latency_hist AS latencyHist
           FROM analytics_daily WHERE ${where.join(' AND ')} ORDER BY day`,
      )
      .all(...params) as Array<Omit<AnalyticsDayRow, 'latencyHist'> & { latencyHist: string }>;
    return rows.map((r) => ({ ...r, latencyHist: JSON.parse(r.latencyHist) as number[] }));
  },

  /**
   * Average duration and per-mode result counts of each case over the window (final attempts, skipped excluded).
   * Slowest-cases input; reads straight from `case_results` through the `(project_id, started_at)` run index.
   */
  async caseDurations(
    db: Db,
    projectId: string,
    f: AnalyticsFilter,
  ): Promise<Array<{ caseId: string; runs: number; totalMs: number; modes: Record<string, number> }>> {
    const where = [
      'r.project_id = ?',
      'r.started_at >= ?',
      'r.started_at < ?',
      "c.verdict != 'skipped'",
      "c.mode != 'manual'",
      FINAL_ATTEMPT,
    ];
    const params: unknown[] = [projectId, `${f.from}T00:00:00.000Z`, `${nextDay(f.to)}T00:00:00.000Z`];
    if (f.environmentId) {
      where.push('c.environment_id = ?');
      params.push(f.environmentId);
    }
    let join = '';
    if (f.suiteId) {
      join = 'JOIN test_cases tc ON tc.id = c.case_id';
      where.push('tc.suite_id = ?');
      params.push(f.suiteId);
    }
    const rows = db.sqlite
      .prepare(
        `SELECT c.case_id AS caseId, c.mode AS mode, COUNT(*) AS n, SUM(c.duration_ms) AS ms
           FROM case_results c JOIN test_runs r ON r.id = c.run_id ${join}
          WHERE ${where.join(' AND ')} GROUP BY c.case_id, c.mode`,
      )
      .all(...params) as Array<{ caseId: string; mode: string; n: number; ms: number }>;
    const out = new Map<string, { caseId: string; runs: number; totalMs: number; modes: Record<string, number> }>();
    for (const r of rows) {
      const o = out.get(r.caseId) ?? { caseId: r.caseId, runs: 0, totalMs: 0, modes: {} };
      o.runs += r.n;
      o.totalMs += r.ms;
      o.modes[r.mode] = (o.modes[r.mode] ?? 0) + r.n;
      out.set(r.caseId, o);
    }
    return [...out.values()];
  },

  /** Verdict and run start of the most recent result of each case of the project (cases without results are absent). */
  async lastVerdicts(db: Db, projectId: string): Promise<Map<string, { verdict: string; startedAt: string | null }>> {
    const rows = db.sqlite
      .prepare(
        `SELECT case_id AS caseId, verdict, started_at AS startedAt FROM (
           SELECT c.case_id, c.verdict, r.started_at,
                  ROW_NUMBER() OVER (PARTITION BY c.case_id ORDER BY r.started_at DESC, c.attempt DESC) AS rn
             FROM case_results c JOIN test_runs r ON r.id = c.run_id WHERE r.project_id = ?
         ) WHERE rn = 1`,
      )
      .all(projectId) as Array<{ caseId: string; verdict: string; startedAt: string | null }>;
    return new Map(rows.map((r) => [r.caseId, { verdict: r.verdict, startedAt: r.startedAt }]));
  },
};
export type AnalyticsRepo = typeof analytics;

/** The UTC day after `YYYY-MM-DD`. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}
