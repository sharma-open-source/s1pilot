import { repos, type Db } from '@s1pilot/db';
import { newId, type Role } from '@s1pilot/domain';

import { SESSION_COOKIE, createSession } from './sessions.js';

/** Test helper: creates an active user (no password) with a session and returns the `Cookie` header value. */
export async function signInAs(db: Db, role: Role, email = `${role}-${newId().slice(0, 6)}@example.com`): Promise<{ userId: string; cookie: string; email: string }> {
  const user = await repos.users.create(db, {
    id: newId(),
    email,
    name: `${role} user`,
    passwordHash: null,
    role,
    status: 'active',
    oidcIssuer: null,
    oidcSubject: null,
    createdAt: new Date().toISOString(),
  });
  const session = await createSession(db, user);
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${encodeURIComponent(session.token)}`, email };
}
