import { WorkerLabelSchema } from '@s1pilot/domain';
import { z } from 'zod';


/** Body of `POST /api/workers/register`. */
export const RegisterWorkerSchema = z.object({
  /** Stable id of the worker process; a re-registering worker (server restarted) keeps it. Generated when absent. */
  id: z.string().regex(/^[\w-]{4,64}$/).optional(),
  name: z.string().min(1).max(80).optional(),
  labels: z.array(WorkerLabelSchema).max(20).default([]),
  version: z.string().max(40).default('unknown'),
  concurrency: z.number().int().min(1).max(64).default(1),
});
export type RegisterWorker = z.infer<typeof RegisterWorkerSchema>;

/** A remote worker as Settings › Workers shows it. */
export interface RemoteWorkerView {
  id: string;
  name: string;
  labels: string[];
  version: string;
  concurrency: number;
  /** `offline` = no heartbeat for longer than the lease. */
  status: 'idle' | 'busy' | 'offline';
  jobs: Array<{ jobId: string; runId?: string }>;
  registeredAt: string;
  lastHeartbeatAt: string;
}

interface Entry extends RegisterWorker {
  id: string;
  name: string;
  registeredAt: number;
  lastHeartbeatAt: number;
  jobs: Map<string, { runId?: string }>;
}

/** Offline workers are forgotten after this long. */
const FORGET_AFTER_MS = 24 * 3_600_000;

/** In-memory list of the remote workers that registered with this server and their heartbeats. */
export class WorkerRegistry {
  private readonly workers = new Map<string, Entry>();

  constructor(
    /** A worker without a heartbeat for this long is `offline`. */
    private readonly offlineAfterMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Adds or refreshes a worker; returns its id. */
  register(input: RegisterWorker, id: string): string {
    const prev = this.workers.get(id);
    this.workers.set(id, {
      ...input,
      id,
      name: input.name ?? id,
      registeredAt: prev?.registeredAt ?? this.now(),
      lastHeartbeatAt: this.now(),
      jobs: prev?.jobs ?? new Map(),
    });
    return id;
  }

  has(id: string): boolean {
    return this.workers.has(id);
  }

  labelsOf(id: string): string[] | undefined {
    return this.workers.get(id)?.labels;
  }

  /** Records a heartbeat. Returns false for an unknown worker. */
  heartbeat(id: string): boolean {
    const w = this.workers.get(id);
    if (!w) return false;
    w.lastHeartbeatAt = this.now();
    return true;
  }

  assign(id: string, jobId: string, runId?: string): void {
    this.workers.get(id)?.jobs.set(jobId, runId ? { runId } : {});
  }

  release(id: string, jobId: string): void {
    this.workers.get(id)?.jobs.delete(jobId);
  }

  /** Drops a job from whichever worker held it (lease expired, run cancelled). */
  releaseJob(jobId: string): void {
    for (const w of this.workers.values()) w.jobs.delete(jobId);
  }

  /** Workers (oldest first) with their state; forgets workers offline for a day. */
  list(): RemoteWorkerView[] {
    const t = this.now();
    const out: RemoteWorkerView[] = [];
    for (const [id, w] of this.workers) {
      const offline = t - w.lastHeartbeatAt > this.offlineAfterMs;
      if (offline && t - w.lastHeartbeatAt > FORGET_AFTER_MS) {
        this.workers.delete(id);
        continue;
      }
      out.push({
        id,
        name: w.name,
        labels: w.labels,
        version: w.version,
        concurrency: w.concurrency,
        status: offline ? 'offline' : w.jobs.size > 0 ? 'busy' : 'idle',
        jobs: [...w.jobs].map(([jobId, j]) => ({ jobId, ...(j.runId ? { runId: j.runId } : {}) })),
        registeredAt: new Date(w.registeredAt).toISOString(),
        lastHeartbeatAt: new Date(w.lastHeartbeatAt).toISOString(),
      });
    }
    return out.sort((a, b) => a.registeredAt.localeCompare(b.registeredAt) || a.id.localeCompare(b.id));
  }
}
