import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { createDbLearnedScriptStore, repos, type Db, type Job, type JobQueue } from '@s1pilot/db';
import {
  FLAKY_WINDOW,
  ModelSettingsSchema,
  S1PilotError,
  flakinessScore,
  newId,
  type CaseRunResult,
  type LearnedScript,
} from '@s1pilot/domain';
import type { RunnerEvent } from '@s1pilot/runner';
import type { FastifyBaseLogger } from 'fastify';

import { createArtifactStore } from '../artifacts/factory.js';
import { ingestCaseArtifacts } from '../artifacts/ingest.js';
import type { ArtifactStore } from '../artifacts/store.js';
import { loadCalibrationState } from '../calibration/service.js';
import type { ServerConfig } from '../config.js';
import { decodeFrame } from '../live/frame.js';
import type { LiveHub } from '../live/hub.js';
import { WORKSPACE_MODEL_KEY } from '../trpc/routers/helpers.js';
import type { RunEventBus } from '../worker/event-bus.js';
import { toRunEvent } from '../worker/events.js';
import { RUN_CASE_JOB, RunCaseJobPayloadSchema, type RunLifecycle } from '../worker/run-lifecycle.js';

import type { ClaimedJob, HeartbeatResult, JobContext, ServerMessage } from './protocol.js';
import { unwrapFrame } from './protocol.js';
import { WorkerRegistry, type RegisterWorker } from './registry.js';

/** Dependencies and tuning of a {@link RemoteWorkerService}. */
export interface RemoteWorkerServiceOptions {
  db: Db;
  config: ServerConfig;
  log: FastifyBaseLogger;
  queue: JobQueue;
  bus: RunEventBus;
  lifecycle: RunLifecycle;
  live: LiveHub;
  /** Artifact store. Default: from the config (S3 or file system). */
  store?: ArtifactStore;
  /** A job whose worker stays silent this long is re-queued. Default `config.workerLeaseSec` or 30 s. */
  leaseMs?: number;
  /** How often expired leases are looked for. Default `leaseMs / 3`, at most 5 s. */
  reapIntervalMs?: number;
}

interface RemoteJob {
  jobId: string;
  workerId: string;
  runId: string;
  caseId: string;
  projectId: string;
  environmentId: string;
  testCase: JobContext['testCase'];
  /** Where uploaded files of the job are collected before they are moved into the artifact store. */
  workDir: string;
  /** Case results recorded but not yet closed with `case-done`. */
  pending: Map<string, { attempt: number; result: CaseRunResult }>;
}

/** A connected `/ws/workers/:id` socket. */
export interface WorkerSocket {
  send(message: ServerMessage): void;
}

/**
 * Server side of remote workers (S-068). A worker on another machine registers, leases `run-case` jobs through the
 * same {@link JobQueue} the in-process pool uses (honouring job labels), receives the job's context, and reports back
 * case results, artifacts, events and screencast frames. Leases expire when a worker stops heartbeating, and the
 * queue re-queues the job for another worker.
 */
export class RemoteWorkerService {
  readonly registry: WorkerRegistry;
  readonly leaseMs: number;
  private readonly o: RemoteWorkerServiceOptions;
  private readonly jobs = new Map<string, RemoteJob>();
  private readonly runSlots = new Map<string, { active: number; cap: number }>();
  private readonly sockets = new Map<string, WorkerSocket>();
  private claimChain: Promise<unknown> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private unsubscribeDemand: (() => void) | undefined;

  constructor(opts: RemoteWorkerServiceOptions) {
    this.o = opts;
    this.leaseMs = opts.leaseMs ?? Math.round((opts.config.workerLeaseSec ?? 30) * 1000);
    this.registry = new WorkerRegistry(this.leaseMs);
  }

  private get store(): ArtifactStore {
    return this.o.store ?? createArtifactStore(this.o.db, this.o.config);
  }

  /** Starts the lease reaper and the screencast demand relay. */
  start(): void {
    if (this.timer) return;
    const every = this.o.reapIntervalMs ?? Math.min(5000, Math.max(100, Math.round(this.leaseMs / 3)));
    this.timer = setInterval(() => void this.reap().catch((err: unknown) => this.o.log.error({ err }, 'remote reap failed')), every);
    this.timer.unref();
    this.unsubscribeDemand = this.o.live.onDemand((runId, subscribers) => this.broadcast({ type: 'demand', runId, subscribers }));
  }

  /** Stops the reaper. Connected workers keep their leases until they expire. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribeDemand?.();
    this.unsubscribeDemand = undefined;
  }

  /** Registers (or re-registers) a worker and tells it how to heartbeat. */
  register(input: RegisterWorker): { id: string; leaseMs: number; heartbeatMs: number } {
    const id = this.registry.register(input, input.id ?? `rw-${newId().slice(0, 10)}`);
    this.o.log.info({ workerId: id, labels: input.labels, version: input.version }, 'remote worker registered');
    return { id, leaseMs: this.leaseMs, heartbeatMs: Math.max(100, Math.round(this.leaseMs / 3)) };
  }

  private requireWorker(workerId: string): void {
    if (!this.registry.has(workerId)) throw new S1PilotError('WORKER_UNKNOWN', `Worker not registered: ${workerId}`, { workerId });
  }

  private requireJob(workerId: string, jobId: string): RemoteJob {
    this.requireWorker(workerId);
    const job = this.jobs.get(jobId);
    if (!job || job.workerId !== workerId) throw new S1PilotError('JOB_NOT_OWNED', `Worker ${workerId} does not own job ${jobId}`, { workerId, jobId });
    return job;
  }

  /**
   * Leases the next job this worker's labels allow and returns it with its context, or undefined when none is
   * queued. Per-run parallelism caps (plan `parallelism`) hold across remote workers.
   */
  async claim(workerId: string): Promise<ClaimedJob | undefined> {
    this.requireWorker(workerId);
    this.registry.heartbeat(workerId);
    const labels = this.registry.labelsOf(workerId) ?? [];
    const step = this.claimChain.then(async (): Promise<Job | undefined> => {
      const full = [...this.runSlots].filter(([, s]) => s.active >= s.cap).map(([id]) => id);
      const job = await this.o.queue.claim(workerId, {
        types: [RUN_CASE_JOB],
        leaseMs: this.leaseMs,
        labels,
        ...(full.length > 0 ? { excludeRunIds: full } : {}),
      });
      if (job?.runId) {
        const parsed = RunCaseJobPayloadSchema.safeParse(job.payload);
        const cap = Math.max(1, parsed.success ? (parsed.data.parallelism ?? Infinity) : Infinity);
        const slot = this.runSlots.get(job.runId) ?? { active: 0, cap };
        slot.active++;
        slot.cap = cap;
        this.runSlots.set(job.runId, slot);
      }
      return job;
    });
    this.claimChain = step.then(
      () => undefined,
      () => undefined,
    );
    const job = await step;
    if (!job) return undefined;
    this.registry.assign(workerId, job.id, job.runId);
    try {
      const { context, remote } = await this.buildContext(workerId, job);
      this.jobs.set(job.id, remote);
      return { job: { id: job.id, ...(job.runId ? { runId: job.runId } : {}), attempts: job.attempts, payload: job.payload }, context, leaseMs: this.leaseMs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.o.log.error({ jobId: job.id, err: error }, 'remote job could not be prepared');
      this.releaseSlot(job.runId);
      this.registry.release(workerId, job.id);
      await this.o.queue.fail(job.id, workerId, message, { retry: false });
      if (job.runId) await this.o.lifecycle.finalize(job.runId);
      return undefined;
    }
  }

  /** Loads what the job needs from the database: case, environment, model settings, secrets, shared steps, calibration. */
  private async buildContext(workerId: string, job: Job): Promise<{ context: JobContext; remote: RemoteJob }> {
    const { db, lifecycle, queue, config } = this.o;
    const payload = RunCaseJobPayloadSchema.parse(job.payload);
    const { runId } = payload;
    const testCase = await repos.cases.get(db, payload.caseId);
    if (!testCase) throw new S1PilotError('CASE_NOT_FOUND', `Case not found: ${payload.caseId}`);
    const environment = await repos.environments.get(db, payload.environmentId);
    if (!environment) throw new S1PilotError('ENVIRONMENT_NOT_FOUND', `Environment not found: ${payload.environmentId}`);
    const project = await repos.projects.get(db, payload.projectId);
    if (!project) throw new S1PilotError('PROJECT_NOT_FOUND', `Project not found: ${payload.projectId}`);
    if (payload.attended) {
      throw new S1PilotError('REMOTE_UNSUPPORTED', 'Attended runs (human in the loop) need an in-process worker; remote workers run unattended jobs only');
    }
    const workspace = ModelSettingsSchema.safeParse(await repos.settings.get(db, WORKSPACE_MODEL_KEY));
    const modelSettings = project.modelSettings ?? (workspace.success ? workspace.data : undefined);
    if (!modelSettings) throw new S1PilotError('MODEL_NOT_CONFIGURED', 'No System 1 model is configured (Settings → Models).');

    const ciphertexts = await repos.environments.secretCiphertexts(db, environment.id);
    const secrets = Object.fromEntries(Object.entries(ciphertexts).map(([key, cipher]) => [key, db.crypto.decrypt(cipher)]));
    const flows = await repos.sharedSteps.listByProject(db, project.id);
    const calibration = (await loadCalibrationState(db, project.id))?.models ?? [];

    await lifecycle.markRunning(runId, (await queue.listByRun(runId)).length);
    if (job.attempts > 1) await lifecycle.discardCase(runId, testCase.id, { environmentId: environment.id, browser: payload.browser });

    return {
      context: {
        testCase,
        environment,
        project: { id: project.id, key: project.key, redactPatterns: project.dataPolicy.redactPatterns },
        modelSettings,
        secrets,
        flows,
        calibration,
      },
      remote: {
        jobId: job.id,
        workerId,
        runId,
        caseId: testCase.id,
        projectId: project.id,
        environmentId: environment.id,
        testCase,
        workDir: join(config.artifactsDir, '.work', 'remote', runId, job.id),
        pending: new Map(),
      },
    };
  }

  /**
   * Worker liveness plus lease renewal for the jobs it is running. `lost` lists jobs the worker no longer owns
   * (lease expired and re-queued, or the run was cancelled): it must stop working on them.
   */
  async heartbeat(workerId: string, jobIds: string[]): Promise<HeartbeatResult> {
    this.requireWorker(workerId);
    this.registry.heartbeat(workerId);
    const lost: string[] = [];
    for (const id of jobIds) {
      const owned = this.jobs.get(id)?.workerId === workerId;
      const ok = owned && (await this.o.queue.heartbeat(id, workerId, this.leaseMs));
      if (!ok) lost.push(id);
    }
    return { ok: true, lost };
  }

  /** Marks the job completed. Returns false when the worker lost the lease meanwhile. */
  async complete(workerId: string, jobId: string): Promise<boolean> {
    const job = this.requireJob(workerId, jobId);
    const ok = await this.o.queue.complete(jobId, workerId, { workerId });
    await this.cleanup(job);
    if (ok) await this.updateFlakiness(job.caseId);
    await this.o.lifecycle.finalize(job.runId);
    return ok;
  }

  /** Marks the job failed, or re-queues it with `retry` while attempts are left. */
  async fail(workerId: string, jobId: string, error: string, retry: boolean): Promise<boolean> {
    const job = this.requireJob(workerId, jobId);
    const ok = await this.o.queue.fail(jobId, workerId, error, { retry });
    await this.cleanup(job);
    await this.o.lifecycle.finalize(job.runId);
    return ok;
  }

  /** Persists a finished case instance (case, steps, decisions). Files follow, then {@link caseDone}. */
  async recordCase(workerId: string, jobId: string, attempt: number, reported: CaseRunResult): Promise<void> {
    const job = this.requireJob(workerId, jobId);
    // The runner mints its own run id; the server's run owns the result.
    const result: CaseRunResult = { ...reported, runId: job.runId };
    await this.o.lifecycle.recordCase({ runId: job.runId, testCase: job.testCase, environmentId: job.environmentId, attempt, result });
    job.pending.set(result.caseResultId, { attempt, result });
  }

  /** Stores one uploaded file of a recorded case result (`file` is relative to the result directory). */
  async receiveFile(workerId: string, jobId: string, caseResultId: string, file: string, data: Buffer): Promise<void> {
    const job = this.requireJob(workerId, jobId);
    const pending = job.pending.get(caseResultId);
    if (!pending) throw new S1PilotError('INVALID_STATE', 'Record the case result before uploading its files', { caseResultId });
    const dir = resolve(job.workDir, `attempt-${pending.attempt}`, pending.result.dir);
    const target = resolve(dir, file);
    if (!target.startsWith(dir + sep)) throw new S1PilotError('ARTIFACT_PATH', 'File path escapes the result directory');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  /** Moves the uploaded files of a case result into the artifact store, links them as evidence and announces the case. */
  async caseDone(workerId: string, jobId: string, caseResultId: string): Promise<number> {
    const job = this.requireJob(workerId, jobId);
    const pending = job.pending.get(caseResultId);
    if (!pending) throw new S1PilotError('INVALID_STATE', 'Unknown case result', { caseResultId });
    job.pending.delete(caseResultId);
    const workDir = join(job.workDir, `attempt-${pending.attempt}`);
    const count = await ingestCaseArtifacts({ db: this.o.db, store: this.store, projectId: job.projectId, workDir, result: pending.result });
    await rm(join(workDir, pending.result.dir), { recursive: true, force: true });
    this.o.bus.emit({
      type: 'case.finished',
      runId: job.runId,
      ts: new Date().toISOString(),
      caseResultId: pending.result.caseResultId,
      verdict: pending.result.verdict,
      durationMs: pending.result.durationMs,
    });
    return count;
  }

  /** Learned script of a case and environment (replay). */
  async getScript(workerId: string, jobId: string, caseId: string, environmentId: string): Promise<LearnedScript | undefined> {
    this.requireJob(workerId, jobId);
    return createDbLearnedScriptStore(this.o.db).get({ caseId, environmentId });
  }

  async putScript(workerId: string, jobId: string, script: LearnedScript): Promise<void> {
    this.requireJob(workerId, jobId);
    await createDbLearnedScriptStore(this.o.db).put({ caseId: script.caseId, environmentId: script.environmentId }, script);
  }

  async createHealProposal(workerId: string, jobId: string, draft: Parameters<typeof repos.healProposals.create>[1]): Promise<void> {
    this.requireJob(workerId, jobId);
    await repos.healProposals.create(this.o.db, draft);
  }

  /** Connects the WebSocket of a worker: current screencast demand goes out at once. Returns the disconnect function. */
  attachSocket(workerId: string, socket: WorkerSocket): () => void {
    this.requireWorker(workerId);
    this.sockets.set(workerId, socket);
    for (const [runId, subscribers] of this.o.live.demand()) socket.send({ type: 'demand', runId, subscribers });
    return () => {
      if (this.sockets.get(workerId) === socket) this.sockets.delete(workerId);
    };
  }

  /** A progress event streamed by a worker: forwarded to the run's subscribers like an in-process event. */
  handleEvent(workerId: string, jobId: string, event: unknown): void {
    const job = this.jobs.get(jobId);
    if (!job || job.workerId !== workerId || typeof event !== 'object' || event === null || typeof (event as { type?: unknown }).type !== 'string') return;
    const forwarded = toRunEvent(event as RunnerEvent, { runId: job.runId, caseId: job.caseId });
    if (forwarded) this.o.bus.emit(forwarded);
  }

  /** A screencast frame streamed by a worker (see `wrapFrame`). */
  handleFrame(workerId: string, data: Buffer): void {
    try {
      const { runId, frame } = unwrapFrame(data);
      // Only frames of runs the worker is executing.
      if ([...this.jobs.values()].some((j) => j.workerId === workerId && j.runId === runId)) this.o.live.publishFrame(runId, decodeFrame(frame));
    } catch {
      // malformed frame: drop
    }
  }

  /** Tells workers to abandon the jobs of a cancelled run now (the next heartbeat would tell them anyway). */
  abortRun(runId: string): void {
    this.broadcast({ type: 'abort', runId });
  }

  private broadcast(message: ServerMessage): void {
    for (const s of this.sockets.values()) s.send(message);
  }

  private releaseSlot(runId: string | undefined): void {
    const slot = runId ? this.runSlots.get(runId) : undefined;
    if (!runId || !slot) return;
    slot.active--;
    if (slot.active <= 0) this.runSlots.delete(runId);
  }

  private async cleanup(job: RemoteJob): Promise<void> {
    if (!this.jobs.delete(job.jobId)) return;
    this.registry.release(job.workerId, job.jobId);
    this.releaseSlot(job.runId);
    await rm(job.workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Re-queues (or fails) jobs whose worker stopped heartbeating, and finalizes runs whose last job just failed. */
  async reap(): Promise<Job[]> {
    const touched = await this.o.queue.reapExpired();
    for (const job of touched) {
      this.o.log.warn({ jobId: job.id, status: job.status, attempts: job.attempts }, 'remote job lease expired');
      const remote = this.jobs.get(job.id);
      if (remote) await this.cleanup(remote);
      this.registry.releaseJob(job.id);
      if (job.status === 'failed' && job.runId) await this.o.lifecycle.finalize(job.runId);
    }
    return touched;
  }

  private async updateFlakiness(caseId: string): Promise<void> {
    const { db } = this.o;
    const byTarget = await repos.results.finalVerdictsByTarget(db, caseId, FLAKY_WINDOW);
    const score = Math.max(0, ...[...byTarget.values()].map((v) => flakinessScore(v)));
    await repos.cases.setFlakiness(db, caseId, score);
  }
}
