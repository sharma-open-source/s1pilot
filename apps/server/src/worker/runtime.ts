import { createSqliteJobQueue, type Db, type JobQueue } from '@s1pilot/db';
import type { FastifyBaseLogger } from 'fastify';

import type { ServerConfig } from '../config.js';
import { HumanControl, type HumanControlOptions } from '../live/control.js';
import { LiveHub } from '../live/hub.js';

import { RunEventBus } from './event-bus.js';
import { createRunLifecycle, type RunLifecycle } from './run-lifecycle.js';
import { WorkerPool, type WorkerPoolOptions } from './worker.js';

/** Everything run execution needs besides the database: queue, event bus, lifecycle and the worker pool. */
export interface ServerRuntime {
  queue: JobQueue;
  bus: RunEventBus;
  lifecycle: RunLifecycle;
  workers: WorkerPool;
  /** WebSocket fan-out of run events and screencast frames (S-036). */
  live: LiveHub;
  /** Escalations, pause/resume, abort and takeover of attended runs (S-037). */
  human: HumanControl;
}

export interface RuntimeOptions {
  db: Db;
  config: ServerConfig;
  log: FastifyBaseLogger;
  /** Takeover browser launcher (tests inject a headless one). */
  launchHeaded?: HumanControlOptions['launchHeaded'];
  /** Screencast tuning (tests). */
  screencast?: ConstructorParameters<typeof LiveHub>[0]['screencast'];
  /** Overrides of the worker pool (model factory, browser launcher, timings). Tests use these. */
  workerOptions?: Partial<Omit<WorkerPoolOptions, 'db' | 'config' | 'log' | 'queue' | 'bus' | 'lifecycle'>>;
}

const runtimes = new WeakMap<Db, ServerRuntime>();

/** Creates the runtime for a database (no workers are started; call `runtime.workers.start(n)`). */
export function createRuntime(opts: RuntimeOptions): ServerRuntime {
  const queue = createSqliteJobQueue(opts.db);
  const bus = new RunEventBus();
  const lifecycle = createRunLifecycle({ db: opts.db, queue, bus });
  const live = new LiveHub({ db: opts.db, bus, ...(opts.screencast ? { screencast: opts.screencast } : {}) });
  const human = new HumanControl({
    db: opts.db,
    bus,
    config: opts.config,
    lifecycle,
    log: opts.log,
    abortRun: async (runId) => {
      await lifecycle.cancel(runId);
      workers.abortRun(runId);
    },
    onStatus: (runId, status) => live.announceStatus(runId, status),
    ...(opts.launchHeaded ? { launchHeaded: opts.launchHeaded } : {}),
  });
  const workers: WorkerPool = new WorkerPool({ human, onPage: (runId, resultId, page) => live.screencast.attach(runId, resultId, page), ...opts.workerOptions, db: opts.db, config: opts.config, log: opts.log, queue, bus, lifecycle });
  const runtime: ServerRuntime = { queue, bus, lifecycle, workers, live, human };
  runtimes.set(opts.db, runtime);
  return runtime;
}

/** The runtime registered for `db`, created (without workers) when none exists yet. */
export function runtimeFor(opts: RuntimeOptions): ServerRuntime {
  return runtimes.get(opts.db) ?? createRuntime(opts);
}

/**
 * Starts `n` in-process workers (`startWorkers(n)` of the spec) on the runtime and returns a function that stops them.
 */
export function startWorkers(runtime: ServerRuntime, n: number): () => Promise<void> {
  runtime.workers.start(n);
  return () => runtime.workers.stop();
}
