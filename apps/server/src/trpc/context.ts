import { repos, type Db } from '@s1pilot/db';
import type { FastifyBaseLogger } from 'fastify';

import type { ServerConfig } from '../config.js';
import { runtimeFor, type ServerRuntime } from '../worker/runtime.js';

/** Authenticated caller. Local mode has a single admin; real auth is S-067. */
export interface ServerUser {
  id: string;
  role: 'admin' | 'lead' | 'tester' | 'viewer';
}

export const LOCAL_USER: ServerUser = { id: 'local', role: 'admin' };

/** Per-request tRPC context. */
export interface Context {
  db: Db;
  repos: typeof repos;
  user: ServerUser;
  config: ServerConfig;
  log: FastifyBaseLogger;
  /** Job queue, event bus, run lifecycle and workers. */
  runtime: ServerRuntime;
}

export interface ServerDeps {
  db: Db;
  config: ServerConfig;
  log: FastifyBaseLogger;
  /** Defaults to the runtime registered for `db` (a queue without workers when none was created). */
  runtime?: ServerRuntime;
}

/** Builds the request context. TODO(S-067): resolve the user from a session in team mode. */
export function createContext(deps: ServerDeps): Context {
  return {
    db: deps.db,
    repos,
    user: LOCAL_USER,
    config: deps.config,
    log: deps.log,
    runtime: deps.runtime ?? runtimeFor({ db: deps.db, config: deps.config, log: deps.log }),
  };
}
