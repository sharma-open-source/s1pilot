import type { JobWithMetadata, PgBoss } from 'pg-boss';

import type { ClaimOptions, Job, JobQueue, JobStatus, NewJob } from './queue.js';

/** Options of {@link createPgBossQueue}. */
export interface PgBossQueueOptions {
  /** `postgres://…` connection string; pg-boss creates its own pool and installs its schema on first use. */
  connectionString: string;
  /** Postgres schema holding the pg-boss tables. Default `pgboss`. */
  schema?: string;
  /** Lease (heartbeat interval) of a claimed job. Default 30 s; pg-boss requires at least 10 s. */
  leaseMs?: number;
  /** Minimum time between two scans for jobs whose worker died. Default 5 s. */
  reapIntervalMs?: number;
  /** Time source (tests). */
  now?: () => Date;
}

/** What is stored in pg-boss as the job's `data`. */
interface Stored {
  type: string;
  runId?: string;
  payload: unknown;
  maxAttempts: number;
}

type Meta = JobWithMetadata<Stored>;

interface Claim {
  workerId: string;
  retryCount: number;
}

const QUEUE_PREFIX = 's1p_';
const DEFAULT_LEASE_MS = 30_000;
/** Hard ceiling on one attempt; the heartbeat is what normally ends a lost job. */
const EXPIRE_SECONDS = 4 * 60 * 60;
const LOST_MESSAGES = ['job heartbeat timeout', 'job timed out'];

function queueNameFor(type: string): string {
  return QUEUE_PREFIX + type.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function splitId(jobId: string): { queue: string; id: string } | undefined {
  const at = jobId.lastIndexOf(':');
  return at > 0 ? { queue: jobId.slice(0, at), id: jobId.slice(at + 1) } : undefined;
}

function statusOf(state: Meta['state']): JobStatus {
  switch (state) {
    case 'created':
    case 'retry':
      return 'queued';
    case 'active':
      return 'running';
    default:
      return state;
  }
}

function outputOf(job: Meta): Record<string, unknown> {
  const out = (job.output ?? {}) as Record<string, unknown>;
  // pg-boss stores what `complete`/`fail` receive under `value`; timeouts it raises itself use the same shape.
  const inner = out['value'];
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : out;
}

/**
 * Creates a {@link JobQueue} on pg-boss (Postgres), for team mode (S-066). Several server / worker processes can
 * share one queue: pg-boss hands every job to exactly one `claim`.
 *
 * Mapping to the S-034 contract: one pg-boss queue per job type; jobs carry `retryLimit: 0` in pg-boss and the
 * `maxAttempts` budget is enforced here (a failed attempt is re-queued with `retry`), so `fail()` without `retry`
 * is terminal; the lease is pg-boss's heartbeat (`touch`); a run id is the pg-boss `group`, which `excludeRunIds`
 * skips; jobs whose worker died (heartbeat timeout) are re-queued by {@link JobQueue.reapExpired}, which `claim`
 * calls first. Worker ownership is remembered per process, so complete/fail/heartbeat must come from the process that
 * claimed. pg-boss is imported lazily and needs Node 22+, local mode never loads it.
 */
export function createPgBossQueue(opts: PgBossQueueOptions): JobQueue {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const heartbeatSeconds = Math.max(10, Math.ceil(leaseMs / 1000));
  const reapIntervalMs = opts.reapIntervalMs ?? 5000;
  const now = opts.now ?? (() => new Date());

  let bossPromise: Promise<PgBoss> | undefined;
  const claims = new Map<string, Claim>();
  const knownQueues = new Set<string>();
  let lastReap = 0;

  const boss = (): Promise<PgBoss> => {
    bossPromise ??= (async () => {
      const { PgBoss: Ctor } = await import('pg-boss');
      const instance = new Ctor({ connectionString: opts.connectionString, schema: opts.schema ?? 'pgboss' });
      // An unhandled 'error' event would crash the process; pg-boss re-emits pool / maintenance errors here.
      instance.on('error', () => undefined);
      await instance.start();
      return instance;
    })();
    // A failed start must not be cached forever.
    bossPromise.catch(() => {
      bossPromise = undefined;
    });
    return bossPromise;
  };

  const ensureQueue = async (b: PgBoss, name: string): Promise<void> => {
    if (knownQueues.has(name)) return;
    await b.createQueue(name, { retryLimit: 0, heartbeatSeconds, expireInSeconds: EXPIRE_SECONDS });
    knownQueues.add(name);
  };

  const allQueues = async (b: PgBoss): Promise<string[]> => {
    const queues = await b.getQueues();
    const names = queues.map((q) => q.name).filter((n) => n.startsWith(QUEUE_PREFIX));
    for (const n of names) knownQueues.add(n);
    return names;
  };

  const toJob = (queue: string, j: Meta): Job => {
    const claim = claims.get(`${queue}:${j.id}`);
    const status = statusOf(j.state);
    const out = outputOf(j);
    const stamp = (d: Date | null | undefined): string | undefined => (d ? new Date(d).toISOString() : undefined);
    const updated = stamp(j.completedOn) ?? stamp(j.heartbeatOn) ?? stamp(j.startedOn) ?? stamp(j.createdOn) ?? now().toISOString();
    const heartbeatOn = j.heartbeatOn ?? j.startedOn;
    const lease =
      status === 'running' && heartbeatOn
        ? new Date(new Date(heartbeatOn).getTime() + (j.heartbeatSeconds ?? heartbeatSeconds) * 1000).toISOString()
        : undefined;
    const raw = typeof out['message'] === 'string' ? out['message'] : undefined;
    const message = raw !== undefined && LOST_MESSAGES.includes(raw) ? 'Worker lost: lease expired' : raw;
    return {
      id: `${queue}:${j.id}`,
      type: j.data.type,
      ...(j.data.runId ? { runId: j.data.runId } : {}),
      payload: j.data.payload,
      status,
      attempts: j.state === 'created' ? 0 : j.retryCount + 1,
      maxAttempts: j.data.maxAttempts,
      ...(claim && status === 'running' ? { workerId: claim.workerId } : {}),
      ...(lease ? { leaseExpiresAt: lease } : {}),
      ...(status === 'completed' && 'result' in out ? { result: out['result'] } : {}),
      ...(status === 'failed' && message ? { error: message } : {}),
      createdAt: stamp(j.createdOn) ?? updated,
      updatedAt: updated,
    };
  };

  const load = async (jobId: string): Promise<Meta | undefined> => {
    const parts = splitId(jobId);
    if (!parts) return undefined;
    const b = await boss();
    return (await b.getJobById<Stored>(parts.queue, parts.id)) ?? undefined;
  };

  const owned = (jobId: string, workerId: string): { queue: string; id: string; claim: Claim } | undefined => {
    const claim = claims.get(jobId);
    const parts = splitId(jobId);
    return claim && claim.workerId === workerId && parts ? { ...parts, claim } : undefined;
  };

  /** Re-queues (or leaves failed) jobs whose heartbeat / timeout ended an attempt. */
  const reap = async (force = false): Promise<Job[]> => {
    const t = Date.now();
    if (!force && t - lastReap < reapIntervalMs) return [];
    lastReap = t;
    const b = await boss();
    const touched: Job[] = [];
    for (const queue of await allQueues(b)) {
      const jobs = await b.findJobs<Stored>(queue);
      for (const j of jobs) {
        if (j.state !== 'failed') continue;
        const message = outputOf(j)['message'];
        if (typeof message !== 'string' || !LOST_MESSAGES.includes(message)) continue;
        // Out of attempts: the job stays failed.
        if (j.retryCount + 1 >= j.data.maxAttempts) continue;
        await b.retry(queue, j.id);
        const after = await b.getJobById<Stored>(queue, j.id);
        if (after) touched.push(toJob(queue, after));
      }
    }
    return touched;
  };

  return {
    async enqueue(job: NewJob) {
      const b = await boss();
      const type = job.type;
      const queue = queueNameFor(type);
      await ensureQueue(b, queue);
      const maxAttempts = job.maxAttempts ?? 2;
      const data: Stored = { type, ...(job.runId ? { runId: job.runId } : {}), payload: job.payload, maxAttempts };
      const id = await b.send(queue, data, {
        retryLimit: 0,
        heartbeatSeconds,
        expireInSeconds: EXPIRE_SECONDS,
        ...(job.runId ? { group: { id: job.runId } } : {}),
      });
      if (!id) throw new Error(`pg-boss refused to enqueue a ${type} job`);
      const created = await b.getJobById<Stored>(queue, id);
      if (!created) throw new Error(`pg-boss lost job ${id}`);
      return toJob(queue, created);
    },

    async claim(workerId: string, claimOpts: ClaimOptions = {}) {
      const b = await boss();
      await reap();
      const queues = claimOpts.types ? claimOpts.types.map(queueNameFor) : await allQueues(b);
      for (const queue of queues) {
        if (claimOpts.types) await ensureQueue(b, queue);
        const [job] = await b.fetch<Stored>(queue, {
          batchSize: 1,
          includeMetadata: true,
          ...(claimOpts.excludeRunIds && claimOpts.excludeRunIds.length > 0 ? { ignoreGroups: claimOpts.excludeRunIds } : {}),
        });
        if (!job) continue;
        claims.set(`${queue}:${job.id}`, { workerId, retryCount: job.retryCount });
        return toJob(queue, job);
      }
      return undefined;
    },

    async heartbeat(jobId: string, workerId: string) {
      const own = owned(jobId, workerId);
      if (!own) return false;
      const b = await boss();
      await b.touch(own.queue, { id: own.id, retryCount: own.claim.retryCount });
      const j = await b.getJobById<Stored>(own.queue, own.id);
      return j?.state === 'active' && j.retryCount === own.claim.retryCount;
    },

    async complete(jobId: string, workerId: string, result?: unknown) {
      const own = owned(jobId, workerId);
      if (!own) return false;
      const b = await boss();
      await b.complete(own.queue, { id: own.id, retryCount: own.claim.retryCount }, { result: result ?? null });
      claims.delete(jobId);
      return (await b.getJobById<Stored>(own.queue, own.id))?.state === 'completed';
    },

    async fail(jobId: string, workerId: string, error: string, failOpts: { retry?: boolean } = {}) {
      const own = owned(jobId, workerId);
      if (!own) return false;
      const b = await boss();
      const before = await b.getJobById<Stored>(own.queue, own.id);
      if (before?.state !== 'active' || before.retryCount !== own.claim.retryCount) return false;
      await b.fail(own.queue, { id: own.id, retryCount: own.claim.retryCount }, { message: error });
      claims.delete(jobId);
      if (failOpts.retry === true && before.retryCount + 1 < before.data.maxAttempts) await b.retry(own.queue, own.id);
      return true;
    },

    async cancel(jobId: string) {
      const parts = splitId(jobId);
      const j = await load(jobId);
      if (!parts || !j || !['created', 'retry', 'active'].includes(j.state)) return false;
      const b = await boss();
      await b.cancel(parts.queue, parts.id);
      claims.delete(jobId);
      return true;
    },

    async cancelByRun(runId: string) {
      const b = await boss();
      const cancelled: Job[] = [];
      for (const queue of await allQueues(b)) {
        const jobs = await b.findJobs<Stored>(queue, { data: { runId } });
        for (const j of jobs) {
          if (!['created', 'retry', 'active'].includes(j.state)) continue;
          cancelled.push(toJob(queue, j));
          await b.cancel(queue, j.id);
          claims.delete(`${queue}:${j.id}`);
        }
      }
      return cancelled;
    },

    reapExpired: () => reap(true),

    async get(jobId: string) {
      const parts = splitId(jobId);
      const j = await load(jobId);
      return parts && j ? toJob(parts.queue, j) : undefined;
    },

    async listByRun(runId: string) {
      const b = await boss();
      const jobs: Job[] = [];
      for (const queue of await allQueues(b)) {
        for (const j of await b.findJobs<Stored>(queue, { data: { runId } })) jobs.push(toJob(queue, j));
      }
      return jobs.sort((a, b2) => a.createdAt.localeCompare(b2.createdAt) || a.id.localeCompare(b2.id));
    },

    async close() {
      const pending = bossPromise;
      bossPromise = undefined;
      if (pending) await (await pending).stop({ graceful: false }).catch(() => undefined);
    },
  };
}
