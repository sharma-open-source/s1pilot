import { newId } from '@s1pilot/domain';
import { and, asc, eq, inArray, isNull, lt, notInArray, or, type SQL } from 'drizzle-orm';

import { atomic, type Db } from './db.js';
import { jobs as t } from './schema/index.js';

/** Lifecycle of a queued job. */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** A unit of work. `payload` / `result` are JSON. */
export interface Job {
  id: string;
  type: string;
  runId?: string;
  payload: unknown;
  status: JobStatus;
  /** Number of times the job was claimed. */
  attempts: number;
  maxAttempts: number;
  workerId?: string;
  /** Labels a worker must carry to claim the job (S-068). Absent = any worker. */
  labels?: string[];
  leaseExpiresAt?: string;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/** Input of {@link JobQueue.enqueue}. */
export interface NewJob {
  type: string;
  runId?: string;
  payload: unknown;
  /** Total attempts (first try + retries). Default 2: a job whose worker died is retried once. */
  maxAttempts?: number;
  /** Only workers carrying all of these labels may claim the job (S-068). */
  labels?: string[];
}

/** Options of {@link JobQueue.claim}. */
export interface ClaimOptions {
  /** Only claim these job types. */
  types?: string[];
  /** Lease length; the worker must {@link JobQueue.heartbeat} before it ends. Default 30 s. */
  leaseMs?: number;
  /** Do not claim jobs of these runs (the pool uses it to honour per-run parallelism caps). */
  excludeRunIds?: string[];
  /**
   * Labels of the claiming worker (S-068). Jobs with labels are only handed to workers carrying all of them; jobs
   * without labels go to anyone. Default: no labels, i.e. labelled jobs are skipped.
   */
  labels?: string[];
}

/** True when a worker with `workerLabels` may run a job that requires `required`. */
export function labelsMatch(required: readonly string[] | undefined, workerLabels: readonly string[] | undefined): boolean {
  if (!required || required.length === 0) return true;
  const have = new Set(workerLabels ?? []);
  return required.every((l) => have.has(l));
}

/**
 * Job queue contract. The SQLite implementation ({@link createSqliteJobQueue}) is replaced by pg-boss ({@link createPgBossQueue}, S-066) in team mode.
 * A claimed job is leased to one worker; if the lease expires without heartbeat the job is re-queued
 * (until `maxAttempts` is reached, then it is `failed`).
 */
export interface JobQueue {
  enqueue(job: NewJob): Promise<Job>;
  /** Claims the oldest queued job (re-queueing / failing jobs with expired leases first). */
  claim(workerId: string, opts?: ClaimOptions): Promise<Job | undefined>;
  /** Extends the lease. Returns false when the worker no longer owns a running job (expired, cancelled). */
  heartbeat(jobId: string, workerId: string, leaseMs?: number): Promise<boolean>;
  /** Marks a running job completed. Returns false when the worker no longer owns it. */
  complete(jobId: string, workerId: string, result?: unknown): Promise<boolean>;
  /** Marks a running job failed (no retry) or, with `retry` and attempts left, queued again. */
  fail(jobId: string, workerId: string, error: string, opts?: { retry?: boolean }): Promise<boolean>;
  /** Cancels a queued or running job. Returns false when it is already finished. */
  cancel(jobId: string): Promise<boolean>;
  /** Cancels every queued or running job of a run; returns the affected jobs (as they were before). */
  cancelByRun(runId: string): Promise<Job[]>;
  /** Re-queues or fails running jobs whose lease expired; returns the jobs touched (state after). */
  reapExpired(): Promise<Job[]>;
  get(jobId: string): Promise<Job | undefined>;
  listByRun(runId: string): Promise<Job[]>;
  /** Releases connections held by the queue (pg-boss). The SQLite queue has nothing to release. */
  close?(): Promise<void>;
}

const DEFAULT_LEASE_MS = 30_000;

function toJob(row: typeof t.$inferSelect): Job {
  return {
    id: row.id,
    type: row.type,
    ...(row.runId ? { runId: row.runId } : {}),
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    ...(row.workerId ? { workerId: row.workerId } : {}),
    ...(row.labels && row.labels.length > 0 ? { labels: row.labels } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt } : {}),
    ...(row.result !== null && row.result !== undefined ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** SQLite-backed {@link JobQueue}. All state changes are single synchronous statements/transactions. */
export function createSqliteJobQueue(db: Db, now: () => Date = () => new Date()): JobQueue {
  const iso = (): string => now().toISOString();
  const lease = (ms: number): string => new Date(now().getTime() + ms).toISOString();
  const owned = (jobId: string, workerId: string) =>
    and(eq(t.id, jobId), eq(t.workerId, workerId), eq(t.status, 'running'));
  const load = (id: string): Job => toJob(db.orm.select().from(t).where(eq(t.id, id)).get() as typeof t.$inferSelect);

  const reap = (): Job[] =>
    atomic(db, () => {
      const expired = db.orm
        .select()
        .from(t)
        .where(and(eq(t.status, 'running'), lt(t.leaseExpiresAt, iso())))
        .all();
      for (const job of expired) {
        const exhausted = job.attempts >= job.maxAttempts;
        db.orm
          .update(t)
          .set(
            exhausted
              ? { status: 'failed', error: 'Worker lost: lease expired', leaseExpiresAt: null, updatedAt: iso() }
              : { status: 'queued', workerId: null, leaseExpiresAt: null, updatedAt: iso() },
          )
          .where(eq(t.id, job.id))
          .run();
      }
      return expired.map((j) => load(j.id));
    });

  return {
    async enqueue(input) {
      const ts = iso();
      const row = {
        id: newId(),
        type: input.type,
        runId: input.runId ?? null,
        payload: input.payload,
        status: 'queued' as const,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? 2,
        labels: input.labels && input.labels.length > 0 ? [...new Set(input.labels)].sort() : null,
        createdAt: ts,
        updatedAt: ts,
      };
      db.orm.insert(t).values(row).run();
      return load(row.id);
    },

    async claim(workerId, opts = {}) {
      reap();
      return atomic(db, () => {
        const conditions: (SQL | undefined)[] = [eq(t.status, 'queued')];
        if (opts.types) conditions.push(inArray(t.type, opts.types));
        if (opts.excludeRunIds && opts.excludeRunIds.length > 0) {
          conditions.push(or(isNull(t.runId), notInArray(t.runId, opts.excludeRunIds)));
        }
        // Label routing is filtered in memory: queued jobs are few and labels are a JSON column.
        const next = db.orm
          .select()
          .from(t)
          .where(and(...conditions))
          .orderBy(asc(t.createdAt), asc(t.id))
          .all()
          .find((row) => labelsMatch(row.labels ?? undefined, opts.labels));
        if (!next) return undefined;
        db.orm
          .update(t)
          .set({
            status: 'running',
            workerId,
            attempts: next.attempts + 1,
            leaseExpiresAt: lease(opts.leaseMs ?? DEFAULT_LEASE_MS),
            updatedAt: iso(),
          })
          .where(eq(t.id, next.id))
          .run();
        return load(next.id);
      });
    },

    async heartbeat(jobId, workerId, leaseMs = DEFAULT_LEASE_MS) {
      const res = db.orm
        .update(t)
        .set({ leaseExpiresAt: lease(leaseMs), updatedAt: iso() })
        .where(owned(jobId, workerId))
        .run();
      return res.changes > 0;
    },

    async complete(jobId, workerId, result) {
      const res = db.orm
        .update(t)
        .set({ status: 'completed', result: result ?? null, leaseExpiresAt: null, updatedAt: iso() })
        .where(owned(jobId, workerId))
        .run();
      return res.changes > 0;
    },

    async fail(jobId, workerId, error, opts = {}) {
      return atomic(db, () => {
        const job = db.orm.select().from(t).where(owned(jobId, workerId)).get();
        if (!job) return false;
        const requeue = opts.retry === true && job.attempts < job.maxAttempts;
        db.orm
          .update(t)
          .set(
            requeue
              ? { status: 'queued', workerId: null, leaseExpiresAt: null, error, updatedAt: iso() }
              : { status: 'failed', leaseExpiresAt: null, error, updatedAt: iso() },
          )
          .where(eq(t.id, jobId))
          .run();
        return true;
      });
    },

    async cancel(jobId) {
      const res = db.orm
        .update(t)
        .set({ status: 'cancelled', leaseExpiresAt: null, updatedAt: iso() })
        .where(and(eq(t.id, jobId), inArray(t.status, ['queued', 'running'])))
        .run();
      return res.changes > 0;
    },

    async cancelByRun(runId) {
      return atomic(db, () => {
        const active = db.orm
          .select()
          .from(t)
          .where(and(eq(t.runId, runId), inArray(t.status, ['queued', 'running'])))
          .all();
        if (active.length > 0) {
          db.orm
            .update(t)
            .set({ status: 'cancelled', leaseExpiresAt: null, updatedAt: iso() })
            .where(
              inArray(
                t.id,
                active.map((j) => j.id),
              ),
            )
            .run();
        }
        return active.map(toJob);
      });
    },

    async reapExpired() {
      return reap();
    },

    async get(jobId) {
      const row = db.orm.select().from(t).where(eq(t.id, jobId)).get();
      return row && toJob(row);
    },

    async listByRun(runId) {
      return db.orm
        .select()
        .from(t)
        .where(eq(t.runId, runId))
        .orderBy(asc(t.createdAt), asc(t.id))
        .all()
        .map(toJob);
    },
  };
}
