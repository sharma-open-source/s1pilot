import { repos, type Db } from '@s1pilot/db';
import type { Role } from '@s1pilot/domain';
import type { FastifyBaseLogger } from 'fastify';

import type { TokenPrincipal } from '../auth/tokens.js';
import type { ServerConfig } from '../config.js';
import { runtimeFor, type ServerRuntime } from '../worker/runtime.js';

/** Authenticated caller. Local mode has a single implicit admin; team mode resolves a session (S-067). */
export interface ServerUser {
  id: string;
  role: Role;
  /** Display name for audit entries. */
  name?: string;
}

export const LOCAL_USER: ServerUser = { id: 'local', role: 'admin', name: 'Local admin' };

/** Server-internal caller (scheduler, inbound webhooks, tracker sync). Never reachable from a request. */
export const SYSTEM_USER: ServerUser = { id: 'system', role: 'admin', name: 'System' };

/** Caller of a team-mode request without a valid session; only the public `session.*` procedures accept it. */
export const ANONYMOUS_USER: ServerUser = { id: 'anonymous', role: 'viewer', name: 'Anonymous' };

/** What the HTTP layer knows about the request behind a context. */
export interface RequestInfo {
  ip?: string | undefined;
  userAgent?: string | undefined;
  /** `Origin` header, checked on cookie-authenticated mutations. */
  origin?: string | undefined;
  host?: string | undefined;
  /** Session that authenticated the request (cookie). */
  sessionId?: string | undefined;
  /** Set when the response must carry a `Set-Cookie` (login, logout, rotation). */
  setCookie?: ((value: string) => void) | undefined;
  secure?: boolean | undefined;
}

/** Per-request tRPC context. */
export interface Context {
  db: Db;
  repos: typeof repos;
  user: ServerUser;
  /** True in team mode when the request has neither a session nor an API token. */
  anonymous: boolean;
  /** Request details (ip, cookies) for audit entries and the session procedures. */
  request: RequestInfo;
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
  /** Session user of the request (team mode). Tests may pass any user to exercise permissions. */
  user?: ServerUser;
  /** Request details; omitted for server-internal contexts. */
  request?: RequestInfo;
}

/**
 * Builds the request context. The user is, in order: the API token principal (a tester), the explicit/session
 * user, or the implicit local admin. In team mode a request with none of these is anonymous.
 */
export function createContext(deps: ServerDeps): Context {
  const team = deps.config.mode === 'team';
  const user = deps.token ? { id: `token:${deps.token.id}`, role: 'tester' as const, name: deps.token.name } : (deps.user ?? (team ? ANONYMOUS_USER : LOCAL_USER));
  return {
    db: deps.db,
    repos,
    user,
    anonymous: team && user === ANONYMOUS_USER,
    request: deps.request ?? {},
    config: deps.config,
    log: deps.log,
    runtime: deps.runtime ?? runtimeFor({ db: deps.db, config: deps.config, log: deps.log }),
    ...(deps.token ? { token: deps.token } : {}),
  };
}
