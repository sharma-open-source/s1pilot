import { repos, type Db, type InviteRecord, type UserRecord } from '@s1pilot/db';
import { S1PilotError, newId, type Role, type User } from '@s1pilot/domain';

import { hashPassword, newToken, sha256, verifyPassword } from './credentials.js';

/** Invite links are valid for 7 days. */
export const INVITE_TTL_MS = 7 * 86_400_000;

/** Public view of a user row. */
export function toUser(r: UserRecord): User {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    status: r.status,
    hasPassword: r.passwordHash !== null,
    sso: r.oidcSubject !== null,
    createdAt: r.createdAt,
    lastLoginAt: r.lastLoginAt,
  };
}

// 10 failed logins per email+ip within 15 minutes lock that pair out until the window passes.
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
const failures = new Map<string, number[]>();

function failureKey(email: string, ip: string | undefined): string {
  return `${email.toLowerCase()}|${ip ?? ''}`;
}

function checkLoginRate(key: string, now: number): void {
  const recent = (failures.get(key) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
  failures.set(key, recent);
  if (recent.length >= FAIL_LIMIT) {
    throw new S1PilotError('RATE_LIMITED', 'Too many failed sign-in attempts. Try again in a few minutes.');
  }
}

/** Creates the first admin of a team-mode workspace. Only allowed while there are no users. */
export async function setupFirstAdmin(db: Db, input: { email: string; name: string; password: string }): Promise<UserRecord> {
  if ((await repos.users.count(db)) > 0) throw new S1PilotError('INVALID_STATE', 'The workspace already has users');
  return repos.users.create(db, {
    id: newId(),
    email: input.email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
    role: 'admin',
    status: 'active',
    oidcIssuer: null,
    oidcSubject: null,
    createdAt: new Date().toISOString(),
  });
}

/** Verifies email + password. Every failure is the same `UNAUTHORIZED` ("Invalid email or password"). */
export async function loginWithPassword(db: Db, input: { email: string; password: string; ip?: string | undefined }): Promise<UserRecord> {
  const now = Date.now();
  const key = failureKey(input.email, input.ip);
  checkLoginRate(key, now);
  const user = await repos.users.getByEmail(db, input.email);
  const ok = await verifyPassword(user?.passwordHash, input.password);
  if (!user || !ok || user.status !== 'active') {
    failures.set(key, [...(failures.get(key) ?? []), now]);
    throw new S1PilotError('UNAUTHORIZED', 'Invalid email or password');
  }
  failures.delete(key);
  return user;
}

export interface CreatedInvite {
  invite: Omit<InviteRecord, 'tokenHash'>;
  /** Plaintext token for the invite link; shown once, only its hash is stored. */
  token: string;
}

/** Admin creates an invite for an email address. A second open invite for the same email replaces the first. */
export async function createInvite(db: Db, input: { email: string; role: Role; createdBy: string }): Promise<CreatedInvite> {
  if (await repos.users.getByEmail(db, input.email)) {
    throw new S1PilotError('CONFLICT', `${input.email} already has an account`, { email: input.email });
  }
  const now = Date.now();
  const open = await repos.users.invites.getOpenByEmail(db, input.email, new Date(now).toISOString());
  if (open) await repos.users.invites.revoke(db, open.id, new Date(now).toISOString());
  const token = newToken();
  const row = {
    id: newId(),
    email: input.email.toLowerCase(),
    role: input.role,
    tokenHash: sha256(token),
    createdBy: input.createdBy,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
  };
  await repos.users.invites.create(db, row);
  return { invite: { id: row.id, email: row.email, role: row.role, createdBy: row.createdBy, createdAt: row.createdAt, expiresAt: row.expiresAt, acceptedAt: null, revokedAt: null }, token };
}

/** The open invite behind a link token, or a `NOT_FOUND`/`INVALID_STATE` error. */
export async function openInvite(db: Db, token: string): Promise<InviteRecord> {
  const invite = await repos.users.invites.getByHash(db, sha256(token));
  if (!invite) throw new S1PilotError('NOT_FOUND', 'This invite link is not valid');
  if (invite.acceptedAt || invite.revokedAt || Date.parse(invite.expiresAt) <= Date.now()) {
    throw new S1PilotError('INVALID_STATE', 'This invite link has expired or was already used');
  }
  return invite;
}

/** Turns an invite into an account with a password. */
export async function acceptInvite(db: Db, input: { token: string; name: string; password: string }): Promise<UserRecord> {
  const invite = await openInvite(db, input.token);
  if (await repos.users.getByEmail(db, invite.email)) throw new S1PilotError('CONFLICT', 'This email already has an account');
  const user = await repos.users.create(db, {
    id: newId(),
    email: invite.email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
    role: invite.role,
    status: 'active',
    oidcIssuer: null,
    oidcSubject: null,
    createdAt: new Date().toISOString(),
  });
  await repos.users.invites.markAccepted(db, invite.id, new Date().toISOString());
  return user;
}

async function requireUser(db: Db, id: string): Promise<UserRecord> {
  const user = await repos.users.get(db, id);
  if (!user) throw new S1PilotError('NOT_FOUND', `User not found: ${id}`, { id });
  return user;
}

/** Changes a role. The last active admin cannot be demoted. */
export async function changeRole(db: Db, id: string, role: Role): Promise<{ before: UserRecord; after: UserRecord }> {
  const before = await requireUser(db, id);
  if (before.role === 'admin' && role !== 'admin' && before.status === 'active' && (await repos.users.countActiveAdmins(db, id)) === 0) {
    throw new S1PilotError('INVALID_STATE', 'The workspace needs at least one active admin');
  }
  await repos.users.update(db, id, { role });
  return { before, after: await requireUser(db, id) };
}

/** Deactivates or reactivates a user; deactivation ends all of their sessions. The last active admin cannot be deactivated. */
export async function setUserStatus(db: Db, id: string, status: 'active' | 'deactivated'): Promise<{ before: UserRecord; after: UserRecord }> {
  const before = await requireUser(db, id);
  if (status === 'deactivated' && before.role === 'admin' && before.status === 'active' && (await repos.users.countActiveAdmins(db, id)) === 0) {
    throw new S1PilotError('INVALID_STATE', 'The workspace needs at least one active admin');
  }
  await repos.users.update(db, id, { status });
  if (status === 'deactivated') await repos.users.sessions.deleteForUser(db, id);
  return { before, after: await requireUser(db, id) };
}
