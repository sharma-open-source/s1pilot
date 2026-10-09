import { repos, type Db } from '@s1pilot/db';
import type { TestPlan } from '@s1pilot/domain';
import { Cron } from 'croner';
import type { FastifyBaseLogger } from 'fastify';

import { isTerminalRunStatus } from '../worker/run-lifecycle.js';

import { getTriggerConfig, workspaceTimezone } from './config.js';

/** True when `expr` is a valid cron expression (5 or 6 fields). */
export function isValidCron(expr: string): boolean {
  try {
    new Cron(expr, { paused: true }).stop();
    return true;
  } catch {
    return false;
  }
}

export interface SchedulerOptions {
  db: Db;
  log: FastifyBaseLogger;
  /** Clock override for `upcoming` (tests). */
  now?: () => Date;
}

/** Callback that creates a run for the plan with `trigger: 'schedule'`. */
export type FirePlan = (planId: string) => Promise<unknown>;

/** One upcoming scheduled firing. */
export interface UpcomingRun {
  planId: string;
  planName: string;
  at: string;
}

/**
 * Cron scheduler for test plans (`croner`). Loads all plans with a non-empty schedule on `start`, and re-reads a
 * plan on `reload`. A scheduled run is skipped while the previous scheduled run of the same plan is still going
 * (per-plan `skipIfRunning`, default on). Empty or invalid schedules mean "off".
 */
export class PlanScheduler {
  private readonly jobs = new Map<string, Cron>();
  private fire: FirePlan | undefined;

  constructor(private readonly opts: SchedulerOptions) {}

  /** Loads every enabled plan schedule and begins firing through `fire`. */
  async start(fire: FirePlan): Promise<void> {
    this.fire = fire;
    for (const project of await repos.projects.list(this.opts.db)) {
      for (const plan of await repos.plans.listByProject(this.opts.db, project.id)) await this.reload(plan.id);
    }
  }

  /** Stops all timers. */
  stop(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    this.fire = undefined;
  }

  /** Number of plans currently scheduled. */
  get size(): number {
    return this.jobs.size;
  }

  /** Re-reads one plan (after create/update/delete or a timezone change). No-op before `start`. */
  async reload(planId: string): Promise<void> {
    if (!this.fire) return;
    this.remove(planId);
    const plan = await repos.plans.get(this.opts.db, planId);
    if (!plan || plan.schedule === undefined || plan.schedule.trim() === '') return;
    const timezone = await this.timezoneFor(plan.id);
    try {
      const job = new Cron(
        plan.schedule,
        { timezone, catch: (error: unknown) => this.opts.log.error({ error, planId }, 'scheduled plan run failed') },
        async () => {
          await this.trigger(planId);
        },
      );
      this.jobs.set(planId, job);
    } catch (error) {
      this.opts.log.warn({ error, planId, schedule: plan.schedule }, 'invalid plan schedule; not scheduled');
    }
  }

  /** Forgets a plan's timer. */
  remove(planId: string): void {
    this.jobs.get(planId)?.stop();
    this.jobs.delete(planId);
  }

  /** Next `count` scheduled firings across the given plans, soonest first. */
  async upcoming(plans: TestPlan[], count = 10): Promise<UpcomingRun[]> {
    const from = this.opts.now?.() ?? new Date();
    const all: UpcomingRun[] = [];
    for (const plan of plans) {
      if (plan.schedule === undefined || plan.schedule.trim() === '') continue;
      const timezone = await this.timezoneFor(plan.id);
      try {
        const cron = new Cron(plan.schedule, { timezone, paused: true });
        for (const d of cron.nextRuns(count, from)) all.push({ planId: plan.id, planName: plan.name, at: d.toISOString() });
        cron.stop();
      } catch {
        // invalid expression: nothing upcoming
      }
    }
    return all.sort((a, b) => a.at.localeCompare(b.at)).slice(0, count);
  }

  private async timezoneFor(planId: string): Promise<string> {
    return (await getTriggerConfig(this.opts.db, planId)).timezone ?? (await workspaceTimezone(this.opts.db));
  }

  /** Fires a plan unless the overlap policy says to skip. Returns true when a run was created. */
  async trigger(planId: string): Promise<boolean> {
    if (!this.fire) return false;
    const config = await getTriggerConfig(this.opts.db, planId);
    if (config.skipIfRunning && (await this.hasActiveScheduledRun(planId))) {
      this.opts.log.info({ planId }, 'previous scheduled run still running; skipping');
      return false;
    }
    await this.fire(planId);
    return true;
  }

  private async hasActiveScheduledRun(planId: string): Promise<boolean> {
    const runs = await repos.runs.listByPlan(this.opts.db, planId, 50);
    return runs.some((r) => r.trigger === 'schedule' && !isTerminalRunStatus(r.status));
  }
}
