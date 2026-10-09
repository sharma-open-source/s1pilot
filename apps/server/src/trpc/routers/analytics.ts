import { histogramPercentile, nextDay, type AnalyticsDayRow, type AnalyticsFilter } from '@s1pilot/db';
import { Calibrator, IdSchema, ProjectKeySchema, type CaseResult, type ReviewItem } from '@s1pilot/domain';
import { z } from 'zod';

import { collectSamples, evaluate, loadCalibrationState } from '../../calibration/service.js';
import { evaluateExitCriteria } from '../../exit-criteria/evaluate.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { toPercentages } from './dashboard.js';
import { effectiveModelSettings, requireProject } from './helpers.js';

type CaseVerdict = CaseResult['verdict'];

const DAY_MS = 86_400_000;

/** Shared filters of the analytics queries. `environment` is an environment name or id; `suite` a suite id. */
export const AnalyticsInput = z.object({
  projectKey: ProjectKeySchema,
  range: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
  environment: z.string().min(1).optional(),
  suite: IdSchema.optional(),
});
type AnalyticsInputT = z.infer<typeof AnalyticsInput>;

/** UTC `YYYY-MM-DD` days covered by a range ending at `now` (oldest first). */
export function rangeDays(range: number, now = new Date()): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: range }, (_, i) => new Date(end - (range - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 10);

/**
 * Expected calibration error over `bins` equal-width confidence bins. Each sample is the model's confidence in
 * the class it favoured and whether that class was right. `null` without samples.
 */
export function expectedCalibrationError(samples: Array<{ confidence: number; correct: boolean }>, bins = 10): number | null {
  if (samples.length === 0) return null;
  const sum = Array.from({ length: bins }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const s of samples) {
    const b = sum[Math.min(bins - 1, Math.floor(s.confidence * bins))];
    if (!b) continue;
    b.n += 1;
    b.conf += s.confidence;
    b.acc += s.correct ? 1 : 0;
  }
  const ece = sum.reduce((a, b) => a + (b.n === 0 ? 0 : (b.n / samples.length) * Math.abs(b.acc / b.n - b.conf / b.n)), 0);
  return Math.round(ece * 1000) / 1000;
}

async function resolveFilter(ctx: Context, input: AnalyticsInputT, now = new Date()) {
  const project = await requireProject(ctx, input.projectKey);
  const envs = await ctx.repos.environments.listByProject(ctx.db, project.id);
  const env = input.environment ? envs.find((e) => e.id === input.environment || e.name === input.environment) : undefined;
  const days = rangeDays(input.range, now);
  const filter: AnalyticsFilter = {
    from: days[0] as string,
    to: days[days.length - 1] as string,
    ...(input.environment ? { environmentId: env?.id ?? '__none__' } : {}),
    ...(input.suite ? { suiteId: input.suite } : {}),
  };
  await ctx.repos.analytics.ensure(ctx.db, project.id);
  return { project, envs, days, filter };
}

const sumRows = (rows: AnalyticsDayRow[], key: 'passed' | 'review' | 'failed' | 'flaky' | 'skipped'): number =>
  rows.reduce((a, r) => a + r[key], 0);

/** Resolved verdict decisions of the range that carry a calibration record (`review_items.outcome`). */
async function reviewedOutcomes(ctx: Context, projectId: string, from: string, to: string): Promise<ReviewItem[]> {
  const items = await ctx.repos.reviews.list(ctx.db, { projectId, kind: 'verdict' });
  const lo = `${from}T00:00:00.000Z`;
  const hi = `${nextDay(to)}T00:00:00.000Z`;
  return items.filter((i) => {
    const at = i.resolvedAt ?? i.createdAt ?? '';
    return i.status !== 'pending' && i.outcome !== undefined && at >= lo && at < hi;
  });
}

/** Analytics for a project (S-057): trends, quality tops, AI model quality, release readiness and coverage. */
export const analyticsRouter = router({
  /** Daily pass rate per environment (percent, `null` for days without results). */
  passRateSeries: publicProcedure.input(AnalyticsInput).query(async ({ ctx, input }) => {
    const { envs, days, filter, project } = await resolveFilter(ctx, input);
    const rows = await ctx.repos.analytics.days(ctx.db, project.id, filter);
    const names = new Map(envs.map((e) => [e.id, e.name]));
    const used = [...new Set(rows.map((r) => r.environmentId))];
    const environments = used.map((id) => names.get(id) ?? 'Unknown').sort();
    const points = days.map((day) => {
      const rates: Record<string, number | null> = Object.fromEntries(environments.map((n) => [n, null]));
      for (const id of used) {
        const dr = rows.filter((r) => r.day === day && r.environmentId === id);
        const total = sumRows(dr, 'passed') + sumRows(dr, 'review') + sumRows(dr, 'failed');
        rates[names.get(id) ?? 'Unknown'] = pct(sumRows(dr, 'passed'), total);
      }
      return { day, rates };
    });
    return { environments, points, total: rows.reduce((a, r) => a + r.passed + r.review + r.failed, 0) };
  }),

  /** Passed / review / failed (flaky included) counts per suite; `flaky` is the subset of `failed`. */
  resultsBySuite: publicProcedure.input(AnalyticsInput).query(async ({ ctx, input }) => {
    const { filter, project } = await resolveFilter(ctx, input);
    const [rows, suites] = await Promise.all([
      ctx.repos.analytics.days(ctx.db, project.id, filter),
      ctx.repos.suites.listByProject(ctx.db, project.id),
    ]);
    const names = new Map(suites.map((s) => [s.id, s.name]));
    const ids = [...new Set(rows.map((r) => r.suiteId))];
    return ids
      .map((id) => {
        const r = rows.filter((x) => x.suiteId === id);
        const passed = sumRows(r, 'passed');
        const review = sumRows(r, 'review');
        const failed = sumRows(r, 'failed');
        return {
          suiteId: id || null,
          suite: id ? (names.get(id) ?? 'Unknown suite') : 'No suite',
          passed,
          review,
          failed,
          flaky: sumRows(r, 'flaky'),
          total: passed + review + failed,
        };
      })
      .filter((s) => s.total > 0)
      .sort((a, b) => a.suite.localeCompare(b.suite));
  }),

  /** The 10 cases with the highest flakiness score (current score; the range does not apply). */
  flakyTop: publicProcedure.input(AnalyticsInput).query(async ({ ctx, input }) => {
    const { project } = await resolveFilter(ctx, input);
    const cases = await ctx.repos.cases.list(ctx.db, { projectId: project.id, ...(input.suite ? { suiteId: input.suite } : {}) });
    return cases
      .filter((c) => (c.flakiness ?? 0) > 0)
      .sort((a, b) => (b.flakiness ?? 0) - (a.flakiness ?? 0) || a.key.localeCompare(b.key))
      .slice(0, 10)
      .map((c) => ({ key: c.key, title: c.title, flakiness: c.flakiness ?? 0, quarantined: c.quarantined ?? false }));
  }),

  /** The 10 cases with the longest average duration in the range, with the mode most of their results used. */
  slowestTop: publicProcedure.input(AnalyticsInput).query(async ({ ctx, input }) => {
    const { filter, project } = await resolveFilter(ctx, input);
    const durations = await ctx.repos.analytics.caseDurations(ctx.db, project.id, filter);
    const top = durations
      .map((d) => ({ ...d, avg: d.totalMs / d.runs }))
      .sort((a, b) => b.avg - a.avg || a.caseId.localeCompare(b.caseId))
      .slice(0, 10);
    const out = [];
    for (const d of top) {
      const c = await ctx.repos.cases.get(ctx.db, d.caseId);
      if (!c) continue;
      const mode = Object.entries(d.modes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'replay';
      out.push({ key: c.key, title: c.title, avgDurationMs: Math.round(d.avg), runs: d.runs, mode: mode === 'healed' ? 'heal' : mode });
    }
    return out;
  }),

  /** Share of executed steps per mode in whole percent (adds up to 100, all 0 without data). */
  modeMix: publicProcedure.input(AnalyticsInput).query(async ({ ctx, input }) => {
    const { filter, project } = await resolveFilter(ctx, input);
    const rows = await ctx.repos.analytics.days(ctx.db, project.id, filter);
    const counts = [
      rows.reduce((a, r) => a + r.stepsReplay, 0),
      rows.reduce((a, r) => a + r.stepsHeal, 0),
      rows.reduce((a, r) => a + r.stepsExplore, 0),
    ];
    const [replay = 0, heal = 0, explore = 0] = toPercentages(counts);
    return { replay, heal, explore };
  }),

  /**
   * System 1 quality. Rates are percentages (`null` = no data). Overrides and ECE come from reviewed verdicts
   * (`review_items.outcome`); `eceCalibrated` is the same data after the fitted temperatures (null until a fit).
   */
  aiQuality: publicProcedure.input(AnalyticsInput).query(async ({ ctx, input }) => {
    const { filter, project } = await resolveFilter(ctx, input);
    const rows = await ctx.repos.analytics.days(ctx.db, project.id, filter);
    const decisions = rows.reduce((a, r) => a + r.decisions, 0);
    const escalated = rows.reduce((a, r) => a + r.escalated, 0);
    const hist = rows.reduce<number[]>((acc, r) => r.latencyHist.map((n, i) => n + (acc[i] ?? 0)), []);
    const results = sumRows(rows, 'passed') + sumRows(rows, 'review') + sumRows(rows, 'failed');

    const reviewed = await reviewedOutcomes(ctx, project.id, filter.from, filter.to);
    const outcomes = reviewed.flatMap((i) => (i.outcome && i.outcome.pTrue !== null ? [i.outcome] : []));
    const lean = (pTrue: number | null): boolean => (pTrue ?? 0) >= 0.5;
    const overridden = outcomes.filter((o) => lean(o.pTrue) !== (o.humanVerdict === 'passed')).length;
    const ece = expectedCalibrationError(
      outcomes.map((o) => {
        const p = o.pTrue ?? 0;
        return { confidence: Math.max(p, 1 - p), correct: lean(p) === (o.humanVerdict === 'passed') };
      }),
    );

    // Heal success: approved share of the decided proposals created in the range.
    const where = ['tc.project_id = ?', 'substr(h.created_at, 1, 10) >= ?', 'substr(h.created_at, 1, 10) <= ?', "h.status != 'pending'"];
    const params: unknown[] = [project.id, filter.from, filter.to];
    if (filter.environmentId) {
      where.push('h.environment_id = ?');
      params.push(filter.environmentId);
    }
    if (filter.suiteId) {
      where.push('tc.suite_id = ?');
      params.push(filter.suiteId);
    }
    const healRows = ctx.db.sqlite
      .prepare(`SELECT h.status AS status, COUNT(*) AS n FROM heal_proposals h JOIN test_cases tc ON tc.id = h.case_id WHERE ${where.join(' AND ')} GROUP BY h.status`)
      .all(...params) as Array<{ status: string; n: number }>;
    const healApproved = healRows.find((r) => r.status === 'approved')?.n ?? 0;
    const healRejected = healRows.find((r) => r.status === 'rejected')?.n ?? 0;

    const settings = await effectiveModelSettings(ctx, project);
    // Calibrated ECE (S-058): the same reviewed outcomes seen through the project's fitted temperatures.
    const state = await loadCalibrationState(ctx.db, project.id);
    const calibrator = new Calibrator(state?.models ?? []);
    const eceCalibrated =
      state === undefined
        ? null
        : (evaluate(await collectSamples(ctx.db, project.id, reviewed), calibrator).eceAfter ?? null);
    return {
      model: settings?.system1.model ?? null,
      decisions,
      escalationRate: pct(escalated, decisions),
      needsReviewRate: pct(sumRows(rows, 'review'), results),
      overrideRate: pct(overridden, outcomes.length),
      ece,
      eceCalibrated,
      /** Stored threshold suggestion of the last fit; applied only by `calibration.applyThresholds`. */
      suggestion: state?.suggestion ?? null,
      reviewedDecisions: reviewed.length,
      latencyP50: histogramPercentile(hist, 0.5),
      latencyP95: histogramPercentile(hist, 0.95),
      healSuccessRate: pct(healApproved, healApproved + healRejected),
      /** When the user last applied suggested thresholds (`calibration.applyThresholds`). */
      lastTunedAt: state?.lastTunedAt ?? (null as string | null),
    };
  }),

  /** Plans with their latest run and live exit-criteria evaluation (all plans, or only `planId`). */
  releaseReadiness: publicProcedure
    .input(z.object({ projectKey: ProjectKeySchema, planId: IdSchema.optional() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.projectKey);
      const plans = (await ctx.repos.plans.listByProject(ctx.db, project.id)).filter((p) => !input.planId || p.id === input.planId);
      const out = [];
      for (const plan of plans) {
        const run = (await ctx.repos.runs.listByPlan(ctx.db, plan.id, 1))[0];
        const evaluation = run ? await evaluateExitCriteria(run, plan, ctx.db) : undefined;
        out.push({
          planId: plan.id,
          plan: plan.name,
          release: plan.release ?? null,
          run: run
            ? { id: run.id, status: run.status, startedAt: run.startedAt ?? null, buildRef: run.buildRef ?? null, summary: run.summary }
            : null,
          criteria: evaluation
            ? {
                met: evaluation.items.filter((i) => i.met).length,
                total: evaluation.items.length,
                allMet: evaluation.met,
                items: evaluation.items,
              }
            : null,
        });
      }
      return out;
    }),

  /** Requirements x covering cases x last result of each case. */
  coverage: publicProcedure
    .input(z.object({ projectKey: ProjectKeySchema, suite: IdSchema.optional() }))
    .query(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.projectKey);
      const [reqs, cases] = await Promise.all([
        ctx.repos.requirements.listByProject(ctx.db, project.id),
        ctx.repos.cases.list(ctx.db, { projectId: project.id }),
      ]);
      const last = await ctx.repos.analytics.lastVerdicts(ctx.db, project.id);
      return reqs.map((r) => {
        const covering = cases
          .filter((c) => r.caseIds.includes(c.id) || c.requirements.includes(r.key))
          .filter((c) => !input.suite || c.suiteId === input.suite);
        const rows = covering.map((c) => ({
          key: c.key,
          title: c.title,
          lastVerdict: (last.get(c.id)?.verdict as CaseVerdict | undefined) ?? null,
          lastRunAt: last.get(c.id)?.startedAt ?? null,
        }));
        const status =
          rows.length === 0
            ? ('uncovered' as const)
            : rows.some((x) => x.lastVerdict === 'failed' || x.lastVerdict === 'blocked' || x.lastVerdict === 'flaky')
              ? ('failing' as const)
              : rows.some((x) => x.lastVerdict === null)
                ? ('not-run' as const)
                : rows.some((x) => x.lastVerdict === 'needs-review')
                  ? ('review' as const)
                  : ('passing' as const);
        return { key: r.key, title: r.title, status, cases: rows };
      });
    }),
});
