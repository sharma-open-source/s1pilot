import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { repos, type Db } from '@s1pilot/db';
import { S1PilotError, newId } from '@s1pilot/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** Scopes an API token can carry. `runs:write` = start/cancel runs and other writes, `results:read` = read-only. */
export const TOKEN_SCOPES = ['runs:write', 'results:read'] as const;
export const TokenScopeSchema = z.enum(TOKEN_SCOPES);
export type TokenScope = z.infer<typeof TokenScopeSchema>;

/** Principal resolved from a bearer token. */
export interface TokenPrincipal {
  id: string;
  name: string;
  scopes: TokenScope[];
}

export const TOKEN_RE = /^s1p_([0-9a-f]{8})_([0-9a-f]{48})$/;

/** Constant-work scrypt hash `scrypt$<saltHex>$<hashHex>`. */
export async function hashToken(token: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(token, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyHash(token: string, stored: string): Promise<boolean> {
  const [kind, saltHex, hashHex] = stored.split('$');
  if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(token, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Public view of a token row: never contains the hash or the secret. */
export interface TokenView {
  id: string;
  name: string;
  /** Visible prefix, e.g. `s1p_1a2b3c4d`. */
  prefix: string;
  scopes: TokenScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function view(r: Awaited<ReturnType<typeof repos.apiTokens.get>> & object): TokenView {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes as TokenScope[],
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  };
}

/** Creates a token. The returned `token` is the only time the plaintext exists; only its scrypt hash is stored. */
export async function createApiToken(
  db: Db,
  input: { name: string; scopes: TokenScope[]; createdBy: string },
): Promise<{ token: string; record: TokenView }> {
  const id = newId();
  const prefix = `s1p_${randomBytes(4).toString('hex')}`;
  const token = `${prefix}_${randomBytes(24).toString('hex')}`;
  await repos.apiTokens.create(db, {
    id,
    name: input.name,
    prefix,
    hash: await hashToken(token),
    scopes: [...new Set(input.scopes)],
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  });
  const row = await repos.apiTokens.get(db, id);
  if (!row) throw new S1PilotError('INTERNAL_ERROR', 'Token was not stored');
  return { token, record: view(row) };
}

export async function listApiTokens(db: Db): Promise<TokenView[]> {
  return (await repos.apiTokens.list(db)).map(view);
}

export async function revokeApiToken(db: Db, id: string): Promise<void> {
  const row = await repos.apiTokens.get(db, id);
  if (!row) throw new S1PilotError('NOT_FOUND', 'Token not found', { id });
  if (!row.revokedAt) await repos.apiTokens.revoke(db, id, new Date().toISOString());
}

// Successful verifications are cached for a short time (keyed by a digest of the token) to avoid a scrypt per request.
// The revocation state is always read from the database, so a revoked token stops working immediately.
const VERIFIED_TTL_MS = 60_000;
const verified = new Map<string, number>();

/** Resolves a bearer token to a principal, or `undefined` when unknown, malformed, wrong or revoked. */
export async function authenticateToken(db: Db, token: string): Promise<TokenPrincipal | undefined> {
  const m = TOKEN_RE.exec(token);
  if (!m) return undefined;
  const row = await repos.apiTokens.getByPrefix(db, `s1p_${m[1]}`);
  if (!row || row.revokedAt) return undefined;
  const cacheKey = `${row.id}:${createHash('sha256').update(token).digest('hex')}`;
  const seen = verified.get(cacheKey);
  if (seen === undefined || seen < Date.now()) {
    if (!(await verifyHash(token, row.hash))) return undefined;
    verified.set(cacheKey, Date.now() + VERIFIED_TTL_MS);
    if (verified.size > 1000) verified.clear();
  }
  await repos.apiTokens.touch(db, row.id, new Date().toISOString());
  return { id: row.id, name: row.name, scopes: row.scopes as TokenScope[] };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the bearer-token hook when the request authenticated with an API token. */
    apiToken?: TokenPrincipal;
  }
}

const bearer = (req: FastifyRequest): string | undefined => {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1];
};

/**
 * Accepts `Authorization: Bearer <token>` on `/api` and `/trpc` in addition to the local session (no header).
 * A bad, unknown or revoked token is `401`; a token without the needed scope is `403`
 * (reads need `results:read` or `runs:write`, anything else needs `runs:write`). Inbound webhooks
 * (`/api/hooks/…`) carry their own token in the path and are left alone.
 */
export function registerTokenAuth(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (!(path.startsWith('/api/') || path.startsWith('/trpc'))) return;
    if (path.startsWith('/api/hooks/')) return;
    const header = req.headers.authorization;
    if (header === undefined) return;
    const token = bearer(req);
    const principal = token ? await authenticateToken(db, token) : undefined;
    if (!principal) {
      return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Invalid or revoked API token' });
    }
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    const allowed = readOnly
      ? principal.scopes.includes('results:read') || principal.scopes.includes('runs:write')
      : principal.scopes.includes('runs:write');
    if (!allowed) {
      return reply.code(403).send({ error: `Token lacks the ${readOnly ? 'results:read' : 'runs:write'} scope` });
    }
    req.apiToken = principal;
    const provider = req.headers[CI_HEADER];
    if (typeof provider === 'string' && CI_PROVIDERS.includes(provider as CiProvider)) {
      await repos.settings.set(db, `${CI_USAGE_PREFIX}${provider}`, new Date().toISOString());
    }
  });
}

/** Header the CLI sends from CI so the server can show GitHub / GitLab as connected (S-063). */
export const CI_HEADER = 'x-s1pilot-ci';
export const CI_PROVIDERS = ['github', 'gitlab', 'other'] as const;
export type CiProvider = (typeof CI_PROVIDERS)[number];
const CI_USAGE_PREFIX = 'integrations.ci.';
/** A CI integration counts as connected when a token with `ci` usage was seen within this many days. */
export const CI_CONNECTED_DAYS = 30;

/** When a CI provider last called the API with a token (ISO), or null; `connected` = within the last 30 days. */
export async function ciUsage(db: Db, now: number = Date.now()): Promise<Record<CiProvider, { lastUsedAt: string | null; connected: boolean }>> {
  const out = {} as Record<CiProvider, { lastUsedAt: string | null; connected: boolean }>;
  for (const p of CI_PROVIDERS) {
    const v = await repos.settings.get(db, `${CI_USAGE_PREFIX}${p}`);
    const at = typeof v === 'string' ? v : null;
    out[p] = { lastUsedAt: at, connected: at !== null && now - Date.parse(at) <= CI_CONNECTED_DAYS * 86_400_000 };
  }
  return out;
}
