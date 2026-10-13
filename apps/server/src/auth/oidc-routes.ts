import { S1PilotError } from '@s1pilot/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { recordAudit } from '../audit/audit.js';
import { createContext, type ServerDeps } from '../trpc/context.js';

import { authDeps } from './http.js';
import { OidcService } from './oidc.js';
import { createSession, sessionCookie } from './sessions.js';

/** Where the provider sends the browser back to: `<public origin>/api/auth/oidc/callback`. */
function redirectUriFor(req: FastifyRequest, deps: ServerDeps): string {
  const origin = deps.config.publicUrl?.replace(/\/$/, '') ?? `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : req.protocol}://${req.headers.host}`;
  return `${origin}/api/auth/oidc/callback`;
}

const loginError = (message: string): string => `/login?error=${encodeURIComponent(message)}`;

/**
 * Team-mode SSO routes (S-067): `GET /api/auth/oidc/login` redirects to the provider, `GET /api/auth/oidc/callback`
 * finishes the sign-in, sets the session cookie and redirects to the app. Registered only when an OIDC provider is configured.
 */
export function registerOidcRoutes(app: FastifyInstance, deps: ServerDeps): OidcService | undefined {
  const { config, db } = deps;
  if (config.mode !== 'team' || !config.oidc) return undefined;
  const oidc = new OidcService(db, config.oidc);

  app.get('/api/auth/oidc/login', async (req, reply) => {
    try {
      const url = await oidc.begin(redirectUriFor(req, deps));
      return reply.redirect(url.href);
    } catch (error) {
      req.log.error({ err: error }, 'oidc: login failed to start');
      return reply.redirect(loginError(error instanceof S1PilotError ? error.message : 'Single sign-on is unavailable'));
    }
  });

  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const provided = new URL(req.url, redirectUriFor(req, deps));
    if (provided.searchParams.get('error')) return reply.redirect(loginError(`The provider refused the sign-in: ${provided.searchParams.get('error')}`));
    try {
      const user = await oidc.complete(provided);
      const auth = authDeps(req, reply, config);
      const session = await createSession(db, user, { ip: req.ip, userAgent: req.headers['user-agent'] });
      reply.header('set-cookie', sessionCookie(session, auth.request?.secure === true));
      await recordAudit(createContext({ ...deps, user: { id: user.id, role: user.role, name: user.name }, ...(auth.request ? { request: auth.request } : {}) }), {
        action: 'auth.login.sso',
        entityType: 'user',
        entityId: user.id,
      });
      return reply.redirect('/');
    } catch (error) {
      if (!(error instanceof S1PilotError)) req.log.error({ err: error }, 'oidc: callback failed');
      return reply.redirect(loginError(error instanceof S1PilotError ? error.message : 'Single sign-on failed'));
    }
  });
  return oidc;
}
