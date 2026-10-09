import { repos, type Db } from '@s1pilot/db';
import type { FastifyBaseLogger } from 'fastify';

import type { TokenPrincipal } from '../auth/tokens.js';
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
  /** Set when the request authenticated with an API token (S-059) instead of the local session. */
  token?: TokenPrincipal;
}

export interface ServerDeps {
  db: Db;
  config: ServerConfig;
  log: FastifyBaseLogger;
  /** Defaults to the runtime registered for `db` (a queue without workers when none was created). */
  runtime?: ServerRuntime;
  /** API token principal of the request, if any. */
  token?: TokenPrincipal;
}

/** Builds the request context. TODO(S-067): resolve the user from a session in team mode. */
export function createContext(deps: ServerDeps): Context {
  return {
    db: deps.db,
    repos,
    user: deps.token ? { id: `token:${deps.token.id}`, role: 'tester' } : LOCAL_USER,
    config: deps.config,
    log: deps.log,
    runtime: deps.runtime ?? runtimeFor({ db: deps.db, config: deps.config, log: deps.log }),
    ...(deps.token ? { token: deps.token } : {}),
  };
}
