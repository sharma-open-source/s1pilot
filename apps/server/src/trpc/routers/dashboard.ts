import type { RunStatus, RunSummary, TestRun } from '@s1pilot/domain';
import { z } from 'zod';

import { RunCaseJobPayloadSchema } from '../../worker/run-lifecycle.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

const DAY_MS = 86_400_000;

/** Percentages of steps executed per mode over the window; whole numbers that add up to 100 (all 0 without data). */
export interface ModeMix {
  replay: number;
  heal: number;
  explore: number;
}

/** Display status of a run as the dashboard shows it (maps onto `StatusPill`). */
export type RunDisplayStatus = 'queued' | 'running' | 'passed' | 'failed' | 'needs-review' | 'cancelled';

/** Pill status for a run: live statuses as-is, finished runs by their summary counts. */
export function displayStatusOf(status: RunStatus, summary: RunSummary): RunDisplayStatus {
  if (status === 'queued') return 'queued';
  if (status === 'running' || status === 'paused') return 'running';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'error' || status === 'failed' || summary.failed > 0 || summary.blocked > 0) return 'failed';
  if (status === 'needs-review' || summary.needsReview > 0) return 'needs-review';
  return 'passed';
}

/** Rounds shares of `counts` to whole percentages that add up to exactly 100 (largest remainder). */
export function toPercentages(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return counts.map(() => 0);
  const raw = counts.map((c) => (c / total) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, rem: r - Math.floor(r) })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left -= 1;
  }
  return floors;
}

const dayStart = (now: Date): number => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

/** Workspace aggregates for the dashboard (all projects). `now` is injectable for tests. */
export function dashboardSummary(ctx: Context, now = new Date()) {
  const sqlite = ctx.db.sqlite;
  const todayStart = dayStart(now);
  const windowStart = todayStart - 6 * DAY_MS;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const one = (sql: string, ...params: unknown[]): number => (sqlite.prepare(sql).get(...params) as { n: number }).n;

  const results = sqlite
    .prepare(
      `SELECT r.started_at AS startedAt, c.verdict AS verdict, COUNT(*) AS n
         FROM case_results c JOIN test_runs r ON r.id = c.run_id
        WHERE r.started_at >= ? AND c.verdict != 'skipped'
          AND NOT EXISTS (SELECT 1 FROM case_results c2 WHERE c2.run_id = c.run_id AND c2.case_id = c.case_id
            AND COALESCE(c2.environment_id, '') = COALESCE(c.environment_id, '') AND COALESCE(c2.browser, '') = COALESCE(c.browser, '') AND c2.attempt > c.attempt)
        GROUP BY r.started_at, c.verdict`,
    )
    .all(iso(windowStart)) as Array<{ startedAt: string; verdict: string; n: number }>;
  const perDay = Array.from({ length: 7 }, () => ({ passed: 0, total: 0 }));
  let passed = 0;
  let total = 0;
  for (const row of results) {
    const t = Date.parse(row.startedAt);
    const idx = Math.min(6, Math.max(0, Math.floor((t - windowStart) / DAY_MS)));
    const day = perDay[idx];
    if (!day) continue;
    day.total += row.n;
    total += row.n;
    if (row.verdict === 'passed') {
      day.passed += row.n;
      passed += row.n;
    }
  }
  const pct = (p: number, t: number): number | null => (t === 0 ? null : Math.round((p / t) * 1000) / 10);

  // Step results carry no mode of their own in the DB; a step counts toward the mode of its case result.
  const stepRows = sqlite
    .prepare(
      `SELECT c.mode AS mode, COUNT(s.id) AS n
         FROM step_results s JOIN case_results c ON c.id = s.case_result_id JOIN test_runs r ON r.id = c.run_id
        WHERE r.started_at >= ? AND c.mode != 'manual'
        GROUP BY c.mode`,
    )
    .all(iso(windowStart)) as Array<{ mode: string; n: number }>;
  const steps = (mode: string): number => stepRows.find((r) => r.mode === mode)?.n ?? 0;
  const [replay = 0, heal = 0, explore = 0] = toPercentages([steps('replay'), steps('healed'), steps('explore')]);

  return {
    passRate7d: pct(passed, total),
    /** Oldest day first, today last; `null` for days without results. */
    passRateSeries: perDay.map((d) => pct(d.passed, d.total)),
    runsToday: one('SELECT COUNT(*) AS n FROM test_runs WHERE started_at >= ?', iso(todayStart)),
    runningNow: one("SELECT COUNT(*) AS n FROM test_runs WHERE status IN ('running', 'paused')"),
    needsReview: one("SELECT COUNT(*) AS n FROM review_items WHERE status = 'pending'"),
    flaky: one(
      `SELECT COUNT(DISTINCT c.case_id) AS n FROM case_results c JOIN test_runs r ON r.id = c.run_id
        WHERE c.verdict = 'flaky' AND r.started_at >= ?`,
      iso(windowStart),
    ),
    quarantined: one('SELECT COUNT(*) AS n FROM test_cases WHERE quarantined = 1'),
    modeMix7d: { replay, heal, explore } satisfies ModeMix,
  };
}

/** Newest runs across all projects with the context a dashboard row needs. */
export async function recentRuns(ctx: Context, limit: number) {
  const { db, repos } = ctx;
  const rows = db.sqlite
    .prepare(`SELECT id FROM test_runs ORDER BY COALESCE(started_at, '9999') DESC, id DESC LIMIT ?`)
    .all(limit) as Array<{ id: string }>;
  const projects = new Map((await repos.projects.list(db)).map((p) => [p.id, p]));
  const envs = new Map<string, string>();
  const out = [];
  for (const { id } of rows) {
    const run = (await repos.runs.get(db, id)) as TestRun;
    const jobs = await ctx.runtime.queue.listByRun(run.id);
    const payloads = jobs.flatMap((j) => {
      const p = RunCaseJobPayloadSchema.safeParse(j.payload);
      return p.success ? [{ status: j.status, ...p.data }] : [];
    });
    const first = payloads[0];
    let environment: string | null = null;
    if (first) {
      if (!envs.has(first.environmentId)) {
        envs.set(first.environmentId, (await repos.environments.get(db, first.environmentId))?.name ?? '');
      }
      environment = envs.get(first.environmentId) || null;
    }
    const plan = run.planId ? await repos.plans.get(db, run.planId) : undefined;
    const project = projects.get(run.projectId);
    const active = payloads.find((p) => p.status === 'running');
    const activeCase = active ? await repos.cases.get(db, active.caseId) : undefined;
    out.push({
      id: run.id,
      projectKey: project?.key ?? '',
      title: `${plan?.name ?? 'Manual run'} · ${project?.key ?? ''}`,
      status: displayStatusOf(run.status, run.summary),
      startedAt: run.startedAt ?? null,
      summary: run.summary,
      environment,
      browsers: [...new Set(payloads.map((p) => p.browser))],
      mode: first?.mode ?? null,
      /** Step count of the case that is running now (the `y` of `step x/y`). */
      activeCaseSteps: activeCase ? activeCase.steps.length : null,
    });
  }
  return out;
}

/** Input of `runs.recent`. */
export const RecentInput = z.object({ limit: z.number().int().min(1).max(50).default(8) }).default({});

/** Dashboard aggregates. */
export const dashboardRouter = router({
  summary: publicProcedure.query(({ ctx }) => dashboardSummary(ctx)),
});
