import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createDbLearnedScriptStore,
  repos,
  resolveVariables,
  type Db,
  type Job,
  type JobQueue,
} from '@s1pilot/db';
import {
  FLAKY_WINDOW,
  ModelSettingsSchema,
  S1PilotError,
  checkConfigFromPlan,
  createRedactor,
  flakinessScore,
  type CaseRunResult,
  type Environment,
  type RunEvent,
  type SharedStep,
} from '@s1pilot/domain';
import { deviceContextOptions, launchBrowser, runCases, type RunCasesInput, type RunnerEvent } from '@s1pilot/runner';
import type { FastifyBaseLogger } from 'fastify';

import { ingestCaseArtifacts } from '../artifacts/ingest.js';
import { FsArtifactStore, type ArtifactStore } from '../artifacts/store.js';
import type { AuthService } from '../auth/service.js';
import type { ServerConfig } from '../config.js';
import type { HumanControl } from '../live/control.js';
import { WORKSPACE_MODEL_KEY } from '../trpc/routers/helpers.js';

import type { RunEventBus } from './event-bus.js';
import { createModelFactory, type ModelFactory } from './models.js';
import { RUN_CASE_JOB, RunCaseJobPayloadSchema, type RunLifecycle } from './run-lifecycle.js';

type Browser = Awaited<ReturnType<typeof launchBrowser>>;

/** Dependencies and tuning of a {@link WorkerPool}. */
export interface WorkerPoolOptions {
  db: Db;
  config: ServerConfig;
  log: FastifyBaseLogger;
  queue: JobQueue;
  bus: RunEventBus;
  lifecycle: RunLifecycle;
  /** Builds System 1/2 from settings. Default: {@link createModelFactory}. Tests inject a mock. */
  createModels?: ModelFactory;
  /** Browser launcher. Default: {@link launchBrowser}. */
  launch?: typeof launchBrowser;
  /** Artifact store. Default: {@link FsArtifactStore} under `config.artifactsDir`. */
  artifacts?: ArtifactStore;
  /** Capture settings of the runner (video is off unless enabled here). */
  capture?: RunCasesInput['capture'];
  /** Idle poll interval. Default 250 ms. */
  pollMs?: number;
  /** Job lease; a worker that stops heartbeating loses its job after this long. Default 30 s. */
  leaseMs?: number;
  /** Heartbeat interval. Default `min(leaseMs / 3, 1000)`. */
  heartbeatMs?: number;
  /** Human-in-the-loop control (S-037): escalation hook, pause points and takeover pages for attended runs. */
  human?: HumanControl;
  /** Saved logins (S-038): restores the storage state of `auth:` preconditions. */
  auth?: AuthService;
  /** Live view hook (S-036): receives the page of every running case; returns a release function. */
  onPage?: (
    runId: string,
    caseResultId: string,
    page: Parameters<NonNullable<RunCasesInput['onPage']>>[0],
  ) => (() => unknown) | undefined;
}

interface WorkerState {
  id: string;
  stopped: boolean;
  crashed: boolean;
  wake?: () => void;
}

interface ActiveJob {
  jobId: string;
  runId: string | undefined;
  workerId: string;
  abort: AbortController;
}

/**
 * In-process workers. Each worker claims `run-case` jobs, builds the engine context from the database
 * (environment, resolved variables, model settings, learned-script and heal-proposal stores), runs the case with
 * `runCases` and persists the results; progress is published on the {@link RunEventBus}.
 */
export class WorkerPool {
  private readonly workers: WorkerState[] = [];
  private readonly loops: Promise<void>[] = [];
  private readonly active = new Map<string, ActiveJob>();
  private readonly browsers = new Map<string, Promise<Browser>>();
  private readonly opts: Required<Pick<WorkerPoolOptions, 'pollMs' | 'leaseMs' | 'heartbeatMs'>> &
    WorkerPoolOptions;
  private readonly runSlots = new Map<string, { active: number; cap: number }>();
  private claimChain: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(opts: WorkerPoolOptions) {
    const leaseMs = opts.leaseMs ?? 30_000;
    this.opts = {
      ...opts,
      pollMs: opts.pollMs ?? 250,
      leaseMs,
      heartbeatMs: opts.heartbeatMs ?? Math.min(leaseMs / 3, 1000),
    };
  }

  /** Starts `n` more workers. */
  start(n: number): void {
    for (let i = 0; i < n; i++) {
      const w: WorkerState = { id: `worker-${++this.seq}`, stopped: false, crashed: false };
      this.workers.push(w);
      this.loops.push(this.loop(w));
    }
  }

  /** Number of workers that are alive. */
  get size(): number {
    return this.workers.filter((w) => !w.stopped).length;
  }

  /** Nudges idle workers to look for new jobs now. */
  wake(): void {
    for (const w of this.workers) w.wake?.();
  }

  /** Aborts the running jobs of a run (used by `runs.cancel`); the browser context is closed immediately. */
  abortRun(runId: string): void {
    for (const a of this.active.values()) if (a.runId === runId) a.abort.abort();
  }

  /**
   * Simulates a worker process dying mid-job: it stops heartbeating and never reports the job, so the
   * queue's lease expiry takes over. For tests.
   */
  crash(workerId: string): void {
    const w = this.workers.find((x) => x.id === workerId);
    if (!w) return;
    w.crashed = true;
    w.stopped = true;
    w.wake?.();
    for (const a of this.active.values()) if (a.workerId === workerId) a.abort.abort();
  }

  /** Stops claiming, aborts running jobs (they are re-queued by lease expiry) and closes browsers. */
  async stop(): Promise<void> {
    for (const w of this.workers) {
      w.stopped = true;
      w.wake?.();
    }
    for (const a of this.active.values()) a.abort.abort();
    await Promise.all(this.loops);
    const browsers = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.all(browsers.map((b) => b.then((x) => x.close()).catch(() => undefined)));
  }

  private sleep(w: WorkerState, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        w.wake = undefined;
        resolve();
      }
      w.wake = done;
    });
  }

  private async loop(w: WorkerState): Promise<void> {
    const { queue, lifecycle, log } = this.opts;
    while (!w.stopped) {
      try {
        for (const job of await queue.reapExpired()) {
          log.warn(
            { jobId: job.id, status: job.status, attempts: job.attempts },
            'job lease expired',
          );
          if (job.status === 'failed' && job.runId) await lifecycle.finalize(job.runId);
        }
        const job = await this.claimNext(w);
        if (!job) {
          await this.sleep(w, this.opts.pollMs);
          continue;
        }
        await this.process(w, job);
      } catch (error) {
        log.error({ err: error, workerId: w.id }, 'worker loop error');
        await this.sleep(w, this.opts.pollMs);
      }
    }
  }

  /**
   * Claims the next job whose run is below its parallelism cap (plan `parallelism`, further capped by the number
   * of server workers). Claims are serialised so the slot is taken before another worker looks.
   */
  private claimNext(w: WorkerState): Promise<Job | undefined> {
    const claim = this.claimChain.then(async () => {
      const full = [...this.runSlots].filter(([, s]) => s.active >= s.cap).map(([id]) => id);
      const job = await this.opts.queue.claim(w.id, {
        types: [RUN_CASE_JOB],
        leaseMs: this.opts.leaseMs,
        ...(full.length > 0 ? { excludeRunIds: full } : {}),
      });
      if (job?.runId) {
        const parsed = RunCaseJobPayloadSchema.safeParse(job.payload);
        const cap = Math.max(1, Math.min(parsed.success ? (parsed.data.parallelism ?? Infinity) : Infinity, this.size));
        const slot = this.runSlots.get(job.runId) ?? { active: 0, cap };
        slot.active++;
        slot.cap = cap;
        this.runSlots.set(job.runId, slot);
      }
      return job;
    });
    this.claimChain = claim.then(
      () => undefined,
      () => undefined,
    );
    return claim;
  }

  private releaseSlot(runId: string | undefined): void {
    const slot = runId ? this.runSlots.get(runId) : undefined;
    if (!runId || !slot) return;
    slot.active--;
    if (slot.active <= 0) this.runSlots.delete(runId);
  }

  private async process(w: WorkerState, job: Job): Promise<void> {
    const { queue, lifecycle, log } = this.opts;
    const abort = new AbortController();
    this.active.set(job.id, { jobId: job.id, runId: job.runId, workerId: w.id, abort });
    const heartbeat = setInterval(() => {
      if (w.crashed || abort.signal.aborted) return;
      queue.heartbeat(job.id, w.id, this.opts.leaseMs).then(
        (ok) => {
          // Lost the lease (expired, or the run was cancelled): stop working on it.
          if (!ok) abort.abort();
        },
        () => undefined,
      );
    }, this.opts.heartbeatMs);
    const aborted = new Promise<'aborted'>((resolve) =>
      abort.signal.addEventListener('abort', () => resolve('aborted'), { once: true }),
    );
    const execution = this.execute(job, abort.signal);
    execution.catch(() => undefined);
    try {
      const outcome = await Promise.race([execution.then(() => 'done' as const), aborted]);
      if (outcome === 'done' && !w.crashed) await queue.complete(job.id, w.id);
    } catch (error) {
      if (!abort.signal.aborted && !w.crashed) {
        const message = error instanceof Error ? error.message : String(error);
        log.error({ jobId: job.id, err: error }, 'job failed');
        await queue.fail(job.id, w.id, message, { retry: !(error instanceof S1PilotError) });
      }
    } finally {
      clearInterval(heartbeat);
      this.active.delete(job.id);
      this.releaseSlot(job.runId);
    }
    if (!w.crashed && job.runId) await lifecycle.finalize(job.runId);
  }

  private getBrowser(name: 'chromium' | 'firefox' | 'webkit'): Promise<Browser> {
    let browser = this.browsers.get(name);
    if (!browser) {
      browser = (this.opts.launch ?? launchBrowser)(name);
      this.browsers.set(name, browser);
      browser.catch(() => this.browsers.delete(name));
    }
    return browser;
  }

  /** Recomputes and stores the flakiness score of a case: the worst score over its environment/browser targets. */
  private async updateFlakiness(caseId: string): Promise<void> {
    const { db } = this.opts;
    const byTarget = await repos.results.finalVerdictsByTarget(db, caseId, FLAKY_WINDOW);
    const score = Math.max(0, ...[...byTarget.values()].map((v) => flakinessScore(v)));
    await repos.cases.setFlakiness(db, caseId, score);
  }

  /** Runs one `run-case` job: builds the engine context from the database, runs the case, persists results. */
  private async execute(job: Job, signal: AbortSignal): Promise<void> {
    const { db, config, bus, lifecycle } = this.opts;
    const payload = RunCaseJobPayloadSchema.parse(job.payload);
    const { runId } = payload;

    const testCase = await repos.cases.get(db, payload.caseId);
    if (!testCase) throw new S1PilotError('CASE_NOT_FOUND', `Case not found: ${payload.caseId}`);
    const environment = await repos.environments.get(db, payload.environmentId);
    if (!environment)
      throw new S1PilotError(
        'ENVIRONMENT_NOT_FOUND',
        `Environment not found: ${payload.environmentId}`,
      );
    const project = await repos.projects.get(db, payload.projectId);
    if (!project)
      throw new S1PilotError('PROJECT_NOT_FOUND', `Project not found: ${payload.projectId}`);

    await lifecycle.markRunning(runId, (await this.opts.queue.listByRun(runId)).length);
    if (job.attempts > 1) {
      await lifecycle.discardCase(runId, testCase.id, { environmentId: environment.id, browser: payload.browser });
    }
    if (payload.device) deviceContextOptions(payload.device, payload.browser);

    const workspace = ModelSettingsSchema.safeParse(
      await repos.settings.get(db, WORKSPACE_MODEL_KEY),
    );
    const settings = project.modelSettings ?? (workspace.success ? workspace.data : undefined);
    if (!settings) {
      throw new S1PilotError(
        'MODEL_NOT_CONFIGURED',
        'No System 1 model is configured (Settings → Models).',
      );
    }
    const vars = resolveVariables(environment, {
      vault: db.crypto,
      ciphertexts: await repos.environments.secretCiphertexts(db, environment.id),
    });
    const redactor = createRedactor({
      secrets: vars.secretValues(),
      patterns: project.dataPolicy.redactPatterns,
    });
    // Models are built per attempt so a retry starts with fresh model state.
    const buildModels = (): ReturnType<ModelFactory> => (this.opts.createModels ?? createModelFactory())(settings, redactor);

    const flows = await repos.sharedSteps.listByProject(db, project.id);
    const flowMap = new Map<string, SharedStep>(
      flows.flatMap((f) => [[f.id, f] as const, [f.name, f] as const]),
    );

    const browser = await this.getBrowser(payload.browser);
    if (signal.aborted) return;

    // Retries (S-051): a failed or blocked instance runs again; each attempt is recorded with all its evidence.
    const maxAttempts = (payload.retries ?? 0) + 1;
    let attempt = 1;
    /** Parameter rows that failed in an earlier attempt: passing now makes them `flaky`. */
    const failedRows = new Set<number>();
    let attemptResults: CaseRunResult[] = [];

    const ts = (): string => new Date().toISOString();
    const store = this.opts.artifacts ?? new FsArtifactStore(db, config.artifactsDir);
    const workDir = join(config.artifactsDir, '.work', runId, job.id);
    let chain: Promise<unknown> = Promise.resolve();
    const handle = (event: RunnerEvent): void => {
      if (signal.aborted) return;
      switch (event.type) {
        case 'engine':
          // The runner's own `step.finished` (below) is authoritative: it follows verification and covers replay.
          if (event.event.type === 'step.finished') break;
          bus.emit({ ...event.event, runId } as RunEvent);
          break;
        case 'case.started':
          bus.emit({
            type: 'case.started',
            runId,
            ts: ts(),
            caseResultId: event.caseResultId,
            caseId: testCase.id,
            caseKey: event.key,
          });
          break;
        case 'note':
          bus.emit({ type: 'log', runId, ts: ts(), level: 'info', message: event.text });
          break;
        case 'step.finished':
          bus.emit({
            type: 'step.finished',
            runId,
            ts: ts(),
            caseResultId: event.caseResultId,
            stepIndex: event.step.index,
            status: ['passed', 'failed', 'blocked', 'skipped'].includes(event.step.verdict)
              ? (event.step.verdict as 'passed')
              : 'blocked',
            durationMs: event.step.durationMs,
          });
          break;
        case 'case.finished': {
          attemptResults.push(event.result);
          const result: CaseRunResult =
            attempt > 1 && event.result.verdict === 'passed' && failedRows.has(event.result.row)
              ? { ...event.result, verdict: 'flaky' }
              : event.result;
          const thisAttempt = attempt;
          chain = chain.then(async () => {
            if (signal.aborted) return;
            await lifecycle.recordCase({
              runId,
              testCase,
              environmentId: environment.id,
              attempt: thisAttempt,
              result,
            });
            await ingestCaseArtifacts({ db, store, projectId: project.id, workDir: join(workDir, `attempt-${thisAttempt}`), result });
            bus.emit({
              type: 'case.finished',
              runId,
              ts: ts(),
              caseResultId: result.caseResultId,
              verdict: result.verdict,
              durationMs: result.durationMs,
            });
          });
          break;
        }
        default:
          break;
      }
    };

    try {
      const session = this.opts.human?.openSession({ runId, projectId: project.id, signal });
      const scripts = createDbLearnedScriptStore(db);
      const runOnce = (): Promise<unknown> => runCases({
        cases: [testCase],
        environment: environment as Environment,
        browser,
        browserName: payload.browser,
        ...(payload.device ? { device: payload.device } : {}),
        mode: payload.mode,
        models: buildModels(),
        stores: {
          // A human who approved a step with "don't save" keeps the explored path out of the learned script.
          scripts: session
            ? {
                ...scripts,
                put: async (ref, script) =>
                  session.skipLearning ? undefined : scripts.put(ref, script),
              }
            : scripts,
          healProposals: { create: (draft) => repos.healProposals.create(db, draft) },
        },
        emit: handle,
        attended: payload.attended,
        ...(session && payload.attended ? { human: session.hook } : {}),
        ...(session ? { beforeStep: session.beforeStep } : {}),
        out: join(workDir, `attempt-${attempt}`),
        ...(this.opts.capture ? { capture: this.opts.capture } : {}),
        ...(payload.checks ? { checks: checkConfigFromPlan(payload.checks) } : {}),
        vars,
        redactor,
        ...(this.opts.auth ? { auth: this.opts.auth.providerFor(browser, this.opts.auth.lazyRefresher(browser, workDir)) } : {}),
        flows: (idOrName) => flowMap.get(idOrName),
        suiteOf: (c) => c.suiteId ?? project.key,
        signal,
        ...(this.opts.onPage || session
          ? {
              onPage: (page, info) => {
                const releaseSession = session?.addPage(page);
                const releaseLive = this.opts.onPage?.(runId, info.caseResultId, page);
                return () => {
                  releaseSession?.();
                  return releaseLive?.();
                };
              },
            }
          : {}),
      });
      try {
        for (; attempt <= maxAttempts; attempt++) {
          attemptResults = [];
          await runOnce();
          await chain;
          const failed = attemptResults.filter((r) => r.verdict === 'failed' || r.verdict === 'blocked');
          if (failed.length === 0 || signal.aborted || attempt === maxAttempts) break;
          for (const r of failed) failedRows.add(r.row);
          bus.emit({
            type: 'log',
            runId,
            ts: ts(),
            level: 'info',
            message: `${testCase.key} failed (attempt ${attempt} of ${maxAttempts}); retrying`,
          });
        }
      } finally {
        session?.close();
      }
      if (!signal.aborted) await this.updateFlakiness(testCase.id);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
