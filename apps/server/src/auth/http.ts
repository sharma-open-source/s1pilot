import type { Db } from '@s1pilot/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ServerConfig } from '../config.js';
import type { ServerDeps, ServerUser } from '../trpc/context.js';

import { SESSION_COOKIE, clearedSessionCookie, parseCookies, resolveSession, sessionCookie } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set in team mode when the session cookie is valid. */
    sessionUser?: ServerUser;
    sessionId?: string;
  }
}

/** Paths reachable without a session in team mode (everything else under `/api` and `/ws` needs one). */
const PUBLIC_PREFIXES = ['/api/health', '/api/hooks/', '/api/auth/'];

const isHttps = (req: FastifyRequest, config: ServerConfig): boolean =>
  config.publicUrl?.startsWith('https:') === true || req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https';

/**
 * Team mode: resolves the session cookie on every request (rotating it when due), answers `401` for
 * `/api` and `/ws` routes without a session or API token, and rejects cross-site cookie-authenticated writes.
 * `/trpc` is not gated here: the procedures decide (the `session.*` procedures are public).
 * Local mode: does nothing; every request is the implicit admin.
 */
export function registerSessionAuth(app: FastifyInstance, db: Db, config: ServerConfig): void {
  if (config.mode !== 'team') return;
  app.addHook('onRequest', async (req, reply) => {
    if (req.apiToken) return;
    const path = req.url.split('?')[0] ?? '';
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const resolved = await resolveSession(db, token);
      if (resolved) {
        req.sessionUser = { id: resolved.user.id, role: resolved.user.role, name: resolved.user.name };
        req.sessionId = resolved.sessionId;
        if (resolved.rotated) reply.header('set-cookie', sessionCookie(resolved.rotated, isHttps(req, config)));
      } else {
        reply.header('set-cookie', clearedSessionCookie(isHttps(req, config)));
      }
    }
    if (req.sessionUser && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin && !sameOrigin(origin, req.headers.host, config)) {
        return reply.code(403).send({ error: 'Cross-site request rejected' });
      }
    }
    const gated = path.startsWith('/api/') || path.startsWith('/ws/');
    if (gated && !req.sessionUser && !PUBLIC_PREFIXES.some((p) => path.startsWith(p))) {
      return reply.code(401).send({ error: 'Sign in required' });
    }
  });
}

function sameOrigin(origin: string, host: string | undefined, config: ServerConfig): boolean {
  try {
    const url = new URL(origin);
    if (config.publicUrl && url.origin === new URL(config.publicUrl).origin) return true;
    return url.host === host;
  } catch {
    return false;
  }
}

/** User and request details of a Fastify request, for building a tRPC context. */
export function authDeps(req: FastifyRequest, reply: FastifyReply | undefined, config: ServerConfig): Pick<ServerDeps, 'user' | 'request'> {
  return {
    ...(req.sessionUser ? { user: req.sessionUser } : {}),
    request: {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      origin: req.headers.origin,
      host: req.headers.host,
      sessionId: req.sessionId,
      secure: isHttps(req, config),
      ...(reply ? { setCookie: (value: string) => void reply.header('set-cookie', value) } : {}),
    },
  };
}
