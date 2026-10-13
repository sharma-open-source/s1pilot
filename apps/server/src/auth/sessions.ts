import { repos, type Db, type UserRecord } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';

import { newToken, sha256 } from './credentials.js';

export const SESSION_COOKIE = 's1p_session';
/** A session lives this long after its last rotation (sliding). */
export const SESSION_TTL_MS = 14 * 86_400_000;
/** The cookie token is replaced when it is older than this. */
export const ROTATE_AFTER_MS = 15 * 60_000;
/** After a rotation the previous token still works for this long (parallel requests, WebSocket reconnects). */
export const ROTATE_GRACE_MS = 60_000;

export interface NewSession {
  token: string;
  expiresAt: string;
}

/** Result of resolving a cookie token. `rotated` is set when the browser must be handed a new cookie. */
export interface ResolvedSession {
  user: UserRecord;
  sessionId: string;
  rotated?: NewSession;
}

/** Opens a session for `user` and returns the cookie token (only its hash is stored). */
export async function createSession(db: Db, user: UserRecord, meta: { ip?: string | undefined; userAgent?: string | undefined } = {}): Promise<NewSession> {
  const token = newToken();
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  await repos.users.sessions.create(db, {
    id: newId(),
    userId: user.id,
    tokenHash: sha256(token),
    prevTokenHash: null,
    createdAt: new Date(now).toISOString(),
    rotatedAt: new Date(now).toISOString(),
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
  });
  await repos.users.update(db, user.id, { lastLoginAt: new Date(now).toISOString() });
  return { token, expiresAt };
}

/**
 * Finds the session of a cookie token. Unknown, expired, or deactivated-user sessions resolve to `undefined`.
 * Tokens older than {@link ROTATE_AFTER_MS} are rotated (rotation also slides the expiry).
 */
export async function resolveSession(db: Db, token: string, now: number = Date.now()): Promise<ResolvedSession | undefined> {
  const hash = sha256(token);
  const current = await repos.users.sessions.getByHash(db, hash);
  const session = current ?? (await repos.users.sessions.getByPrevHash(db, hash));
  if (!session) return undefined;
  const usedPrevious = current === undefined;
  if (Date.parse(session.expiresAt) <= now) {
    await repos.users.sessions.delete(db, session.id);
    return undefined;
  }
  if (usedPrevious && now - Date.parse(session.rotatedAt) > ROTATE_GRACE_MS) return undefined;
  const user = await repos.users.get(db, session.userId);
  if (!user || user.status !== 'active') return undefined;
  if (usedPrevious || now - Date.parse(session.rotatedAt) <= ROTATE_AFTER_MS) return { user, sessionId: session.id };
  const next = newToken();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  await repos.users.sessions.rotate(db, session.id, {
    tokenHash: sha256(next),
    prevTokenHash: hash,
    rotatedAt: new Date(now).toISOString(),
    expiresAt,
  });
  return { user, sessionId: session.id, rotated: { token: next, expiresAt } };
}

/** Ends the session of a cookie token (logout). */
export async function destroySession(db: Db, token: string): Promise<void> {
  const hash = sha256(token);
  const session = (await repos.users.sessions.getByHash(db, hash)) ?? (await repos.users.sessions.getByPrevHash(db, hash));
  if (session) await repos.users.sessions.delete(db, session.id);
}

/** Parses a `Cookie` request header. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

/** `Set-Cookie` value for the session: httpOnly, SameSite=Lax, `Secure` when served over https. */
export function sessionCookie(session: NewSession, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(session.expiresAt) - Date.now()) / 1000));
  return `${SESSION_COOKIE}=${encodeURIComponent(session.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}
