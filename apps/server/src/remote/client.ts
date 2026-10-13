import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { datasetBaseName, resolveVariables } from '@s1pilot/db';
import {
  Calibrator,
  S1PilotError,
  checkConfigFromPlan,
  createRedactor,
  newId,
  LearnedScriptSchema,
  type CaseRunResult,
  type Environment,
  type LearnedScript,
  type SharedStep,
} from '@s1pilot/domain';
import { deviceContextOptions, launchBrowser, runCases, type RunCasesInput, type RunnerEvent } from '@s1pilot/runner';
import WebSocket from 'ws';

import { encodeFrame } from '../live/frame.js';
import { ScreencastManager, type ScreencastOptions } from '../live/screencast.js';
import { createModelFactory, type ModelFactory } from '../worker/models.js';
import { RunCaseJobPayloadSchema } from '../worker/run-lifecycle.js';

import { JobContextSchema, wrapFrame, type ClaimedJob, type HeartbeatResult, type ServerMessage } from './protocol.js';

type Browser = Awaited<ReturnType<typeof launchBrowser>>;

/** Minimal logger the worker needs (pino and Fastify loggers fit). */
export interface WorkerLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/** Options of {@link RemoteWorker}. */
export interface RemoteWorkerOptions {
  /** Base URL of the server, e.g. `https://s1pilot.example.com`. */
  server: string;
  /** API token with the `runs:write` scope. Never logged. */
  token: string;
  /** Jobs run at the same time (each in its own browser context). Default 1. */
  concurrency?: number;
  /** Labels this worker carries; plans can require them. */
  labels?: string[];
  name?: string;
  /** Stable worker id; generated when absent. */
  id?: string;
  version?: string;
  log?: WorkerLogger;
  /** Builds System 1/2 from the settings the server sends. API keys come from this machine's environment. */
  createModels?: ModelFactory;
  /** Browser launcher. Default {@link launchBrowser}. */
  launch?: typeof launchBrowser;
  capture?: RunCasesInput['capture'];
  /** Idle poll interval. Default 1 s. */
  pollMs?: number;
  /** Scratch directory for artifacts before they are uploaded. Default: the OS temp dir. */
  workDir?: string;
  /** Screencast tuning (tests). */
  screencast?: Omit<ScreencastOptions, 'onFrame'>;
}

const silent: WorkerLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const identityVault = { encrypt: (s: string): string => s, decrypt: (s: string): string => s };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Running {
  jobId: string;
  runId: string | undefined;
  abort: AbortController;
}

/**
 * A worker process that runs on another machine than the server (S-068; `s1pilot worker`). It registers with the
 * server, heartbeats, leases `run-case` jobs matching its labels, runs them against this machine's browsers and
 * model keys, and sends case results and artifacts back over the API, and live events and screencast frames over a
 * WebSocket. It needs no database access.
 */
export class RemoteWorker {
  private readonly base: string;
  private readonly slots: number;
  private readonly running = new Map<string, Running>();
  private readonly browsers = new Map<string, Promise<Browser>>();
  private readonly screencast: ScreencastManager;
  private workerId: string;
  private heartbeatMs = 5000;
  private stopped = true;
  private crashed = false;
  private wake = new Set<() => void>();
  private loops: Promise<void>[] = [];
  private timers: NodeJS.Timeout[] = [];
  private ws: WebSocket | undefined;
  private wsReady = false;
  private wsTimer: NodeJS.Timeout | undefined;

  constructor(private readonly o: RemoteWorkerOptions) {
    this.base = o.server.replace(/\/+$/, '');
    this.slots = Math.max(1, o.concurrency ?? 1);
    this.workerId = o.id ?? `rw-${newId().slice(0, 10)}`;
    this.screencast = new ScreencastManager({
      ...(o.screencast ?? {}),
      onFrame: (runId, frame) => {
        if (this.ws && this.wsReady && this.ws.bufferedAmount < 2 * 1024 * 1024) this.ws.send(wrapFrame(runId, encodeFrame(frame)), { binary: true });
      },
    });
  }

  private get log(): WorkerLogger {
    return this.o.log ?? silent;
  }

  /** Id the server knows this worker by. */
  get id(): string {
    return this.workerId;
  }

  /** Number of jobs running right now. */
  get activeJobs(): number {
    return this.running.size;
  }

  private async http<T>(method: string, path: string, body?: unknown, raw?: Buffer): Promise<{ status: number; json: T }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.o.token}`,
        ...(raw ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(raw ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return { status: 204, json: undefined as T };
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) throw new HttpError(res.status, (json as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`);
    return { status: res.status, json: json as T };
  }

  private async register(): Promise<void> {
    const { json } = await this.http<{ id: string; heartbeatMs: number }>('POST', '/api/workers/register', {
      id: this.workerId,
      ...(this.o.name ? { name: this.o.name } : {}),
      labels: this.o.labels ?? [],
      version: this.o.version ?? 'unknown',
      concurrency: this.slots,
    });
    this.workerId = json.id;
    this.heartbeatMs = json.heartbeatMs;
  }

  /** Registers with the server and starts heartbeating and claiming jobs. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    await this.register();
    this.stopped = false;
    this.crashed = false;
    this.log.info({ workerId: this.workerId, labels: this.o.labels ?? [], slots: this.slots }, 'worker registered');
    this.connectSocket();
    const beat = (): void => void this.beat();
    this.timers.push(setInterval(beat, this.heartbeatMs));
    for (let i = 0; i < this.slots; i++) this.loops.push(this.loop());
  }

  /** Stops claiming, abandons running jobs (the server re-queues them after the lease) and closes browsers. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.wsTimer) clearTimeout(this.wsTimer);
    this.ws?.close();
    for (const r of this.running.values()) r.abort.abort();
    for (const w of this.wake) w();
    await Promise.all(this.loops);
    this.loops = [];
    const browsers = [...this.browsers.values()];
    this.browsers.clear();
    await Promise.all(browsers.map((b) => b.then((x) => x.close()).catch(() => undefined)));
  }

  /** Simulates the machine vanishing: no more heartbeats, results or reports. For tests. */
  crash(): void {
    this.crashed = true;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.wsTimer) clearTimeout(this.wsTimer);
    this.ws?.terminate();
    for (const r of this.running.values()) r.abort.abort();
    for (const w of this.wake) w();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake.add(done);
    });
  }

  private async beat(): Promise<void> {
    if (this.stopped || this.crashed) return;
    try {
      const { json } = await this.http<HeartbeatResult>('POST', `/api/workers/${this.workerId}/heartbeat`, { jobs: [...this.running.keys()] });
      for (const id of json.lost) {
        this.log.warn({ jobId: id }, 'job lost (lease expired or run cancelled); abandoning');
        this.running.get(id)?.abort.abort();
      }
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        // The server restarted and forgot us.
        await this.register().catch(() => undefined);
      } else {
        this.log.warn({ err: error instanceof Error ? error.message : String(error) }, 'heartbeat failed');
      }
    }
  }

  private connectSocket(): void {
    if (this.stopped) return;
    const url = `${this.base.replace(/^http/, 'ws')}/ws/workers/${this.workerId}`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.o.token}` } });
    this.ws = ws;
    this.wsReady = false;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'ready') this.wsReady = true;
      else if (msg.type === 'demand') this.screencast.setDemand(msg.runId, msg.subscribers);
      else if (msg.type === 'abort') for (const r of this.running.values()) if (r.runId === msg.runId) r.abort.abort();
    });
    const retry = (): void => {
      if (this.ws !== ws) return;
      this.wsReady = false;
      if (!this.stopped) this.wsTimer = setTimeout(() => this.connectSocket(), 2000);
    };
    ws.on('close', retry);
    ws.on('error', () => undefined);
  }

  private sendEvent(jobId: string, event: RunnerEvent): void {
    if (this.ws && this.wsReady) this.ws.send(JSON.stringify({ type: 'event', jobId, event }));
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let claimed: ClaimedJob | undefined;
      try {
        const res = await this.http<ClaimedJob | undefined>('POST', `/api/workers/${this.workerId}/claim`);
        claimed = res.status === 204 ? undefined : res.json;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) await this.register().catch(() => undefined);
        else this.log.warn({ err: error instanceof Error ? error.message : String(error) }, 'claim failed');
      }
      if (!claimed) {
        await this.sleep(this.o.pollMs ?? 1000);
        continue;
      }
      await this.process(claimed);
    }
  }

  private async process(claimed: ClaimedJob): Promise<void> {
    const jobId = claimed.job.id;
    const abort = new AbortController();
    this.running.set(jobId, { jobId, runId: claimed.job.runId, abort });
    const aborted = new Promise<'aborted'>((resolve) => abort.signal.addEventListener('abort', () => resolve('aborted'), { once: true }));
    const execution = this.execute(claimed, abort.signal);
    execution.catch(() => undefined);
    try {
      // An abandoned job must not keep the worker busy, even when its model call never returns.
      const outcome = await Promise.race([execution.then(() => 'done' as const), aborted]);
      if (outcome === 'done' && !abort.signal.aborted && !this.crashed) await this.http('POST', `/api/workers/${this.workerId}/jobs/${jobId}/complete`, {}).catch(this.ignoreLost);
    } catch (error) {
      if (!abort.signal.aborted && !this.crashed) {
        const message = error instanceof Error ? error.message : String(error);
        this.log.error({ jobId, err: message }, 'job failed');
        await this.http('POST', `/api/workers/${this.workerId}/jobs/${jobId}/fail`, { error: message, retry: !(error instanceof S1PilotError) }).catch(this.ignoreLost);
      }
    } finally {
      this.running.delete(jobId);
    }
  }

  /** A 409 means the lease was lost meanwhile (the job runs elsewhere now); nothing to report. */
  private readonly ignoreLost = (error: unknown): void => {
    if (!(error instanceof HttpError && error.status === 409)) this.log.warn({ err: error instanceof Error ? error.message : String(error) }, 'report failed');
  };

  private getBrowser(name: 'chromium' | 'firefox' | 'webkit'): Promise<Browser> {
    let browser = this.browsers.get(name);
    if (!browser) {
      browser = (this.o.launch ?? launchBrowser)(name);
      this.browsers.set(name, browser);
      browser.catch(() => this.browsers.delete(name));
    }
    return browser;
  }

  /** Runs one leased job: the same retry / flaky logic as the in-process worker, with results sent to the server. */
  private async execute(claimed: ClaimedJob, signal: AbortSignal): Promise<void> {
    const jobId = claimed.job.id;
    const payload = RunCaseJobPayloadSchema.parse(claimed.job.payload);
    const { runId } = payload;
    const ctx = JobContextSchema.parse(claimed.context);
    const { testCase } = ctx;
    if (payload.device) deviceContextOptions(payload.device, payload.browser);

    const vars = resolveVariables(ctx.environment, { vault: identityVault, ciphertexts: ctx.secrets });
    const redactor = createRedactor({ secrets: vars.secretValues(), patterns: ctx.project.redactPatterns });
    const buildModels = (): ReturnType<ModelFactory> => (this.o.createModels ?? createModelFactory())(ctx.modelSettings, redactor, new Calibrator(ctx.calibration));
    const flowMap = new Map<string, SharedStep>(ctx.flows.flatMap((f) => [[f.id, f] as const, [f.name, f] as const]));
    const browser = await this.getBrowser(payload.browser);
    if (signal.aborted) return;

    const api = `/api/workers/${this.workerId}/jobs/${jobId}`;
    const scripts = {
      get: async (ref: { caseId: string; environmentId: string }): Promise<LearnedScript | undefined> => {
        const { json } = await this.http<{ script: unknown }>('POST', `${api}/scripts/get`, { caseId: ref.caseId, environmentId: ref.environmentId });
        return json.script ? LearnedScriptSchema.parse(json.script) : undefined;
      },
      put: async (_ref: unknown, script: LearnedScript): Promise<void> => {
        await this.http('POST', `${api}/scripts/put`, { script });
      },
      delete: async (): Promise<void> => undefined,
    };

    const maxAttempts = (payload.retries ?? 0) + 1;
    let attempt = 1;
    const failedRows = new Set<number>();
    let attemptResults: CaseRunResult[] = [];
    const workDir = join(this.o.workDir ?? tmpdir(), 's1pilot-worker', this.workerId, runId, jobId);
    await mkdir(workDir, { recursive: true });
    let chain: Promise<unknown> = Promise.resolve();

    const upload = async (result: CaseRunResult, thisAttempt: number): Promise<void> => {
      await this.http('POST', `${api}/case-result`, { attempt: thisAttempt, result });
      const dir = join(workDir, `attempt-${thisAttempt}`, result.dir);
      const files = [
        ...result.steps.flatMap((s) => (s.screenshot ? [s.screenshot] : [])),
        ...(result.files ?? []).map((f) => f.file),
      ];
      for (const file of new Set(files)) {
        let data: Buffer;
        try {
          data = await readFile(join(dir, file));
        } catch {
          continue; // not written (capture off or failed)
        }
        await this.http('PUT', `${api}/files?caseResultId=${encodeURIComponent(result.caseResultId)}&file=${encodeURIComponent(file)}`, undefined, data);
      }
      await this.http('POST', `${api}/case-done`, { caseResultId: result.caseResultId, attempt: thisAttempt });
    };

    const handle = (event: RunnerEvent): void => {
      if (signal.aborted) return;
      if (event.type === 'case.finished') {
        attemptResults.push(event.result);
        const result: CaseRunResult =
          attempt > 1 && event.result.verdict === 'passed' && failedRows.has(event.result.row) ? { ...event.result, verdict: 'flaky' } : event.result;
        const thisAttempt = attempt;
        chain = chain.then(() => (signal.aborted ? undefined : upload(result, thisAttempt)));
        // A failed upload must fail the job, not vanish: keep the rejection on the chain.
        chain.catch(() => undefined);
        return;
      }
      if (event.type !== 'run.started' && event.type !== 'run.finished') this.sendEvent(jobId, event);
    };

    const scriptStore = { get: scripts.get, put: scripts.put, delete: scripts.delete } as unknown as NonNullable<RunCasesInput['stores']>['scripts'];
    const runOnce = (): Promise<unknown> =>
      runCases({
        cases: [testCase],
        environment: ctx.environment as Environment,
        browser,
        browserName: payload.browser,
        ...(payload.device ? { device: payload.device } : {}),
        mode: payload.mode,
        models: buildModels(),
        stores: {
          scripts: scriptStore,
          healProposals: { create: (draft) => this.http('POST', `${api}/heal-proposals`, draft).then(() => undefined) },
        },
        emit: handle,
        attended: false,
        out: join(workDir, `attempt-${attempt}`),
        ...(this.o.capture ? { capture: this.o.capture } : {}),
        ...(payload.checks ? { checks: checkConfigFromPlan(payload.checks) } : {}),
        vars,
        redactor,
        flows: (idOrName) => flowMap.get(idOrName),
        datasets: (name) => ctx.datasets[datasetBaseName(name)],
        suiteOf: (c) => c.suiteId ?? ctx.project.key,
        signal,
        onPage: (page, info) => {
          const release = this.screencast.attach(runId, info.caseResultId, page);
          return () => release();
        },
      });

    try {
      for (; attempt <= maxAttempts; attempt++) {
        attemptResults = [];
        await runOnce();
        await chain;
        const failed = attemptResults.filter((r) => r.verdict === 'failed' || r.verdict === 'blocked');
        if (failed.length === 0 || signal.aborted || attempt === maxAttempts) break;
        for (const r of failed) failedRows.add(r.row);
        this.sendEvent(jobId, { type: 'note', caseResultId: '', text: `${testCase.key} failed (attempt ${attempt} of ${maxAttempts}); retrying` });
      }
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
