import { createSqliteJobQueue, type Db, type JobQueue } from '@s1pilot/db';
import type { FastifyBaseLogger } from 'fastify';

import type { ServerConfig } from '../config.js';

import { RunEventBus } from './event-bus.js';
import { createRunLifecycle, type RunLifecycle } from './run-lifecycle.js';
import { WorkerPool, type WorkerPoolOptions } from './worker.js';

/** Everything run execution needs besides the database: queue, event bus, lifecycle and the worker pool. */
export interface ServerRuntime {
  queue: JobQueue;
  bus: RunEventBus;
  lifecycle: RunLifecycle;
  workers: WorkerPool;
}

export interface RuntimeOptions {
  db: Db;
  config: ServerConfig;
  log: FastifyBaseLogger;
  /** Overrides of the worker pool (model factory, browser launcher, timings). Tests use these. */
  workerOptions?: Partial<Omit<WorkerPoolOptions, 'db' | 'config' | 'log' | 'queue' | 'bus' | 'lifecycle'>>;
}

const runtimes = new WeakMap<Db, ServerRuntime>();

/** Creates the runtime for a database (no workers are started; call `runtime.workers.start(n)`). */
export function createRuntime(opts: RuntimeOptions): ServerRuntime {
  const queue = createSqliteJobQueue(opts.db);
  const bus = new RunEventBus();
  const lifecycle = createRunLifecycle({ db: opts.db, queue, bus });
  const workers = new WorkerPool({ ...opts.workerOptions, db: opts.db, config: opts.config, log: opts.log, queue, bus, lifecycle });
  const runtime: ServerRuntime = { queue, bus, lifecycle, workers };
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
