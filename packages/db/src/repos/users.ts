import type { Role } from '@s1pilot/domain';
import { and, count, desc, eq, isNull, lt, ne } from 'drizzle-orm';

import type { Db } from '../db.js';
import { invites as inv, sessions as ses, users as t } from '../schema/index.js';

/** A stored user row, including the password hash (never sent to clients). */
export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  role: Role;
  status: 'active' | 'deactivated';
  oidcIssuer: string | null;
  oidcSubject: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  prevTokenHash: string | null;
  createdAt: string;
  rotatedAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
}

export interface InviteRecord {
  id: string;
  email: string;
  role: Role;
  tokenHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

/** Users, login sessions and invites (S-067). Tokens are only ever passed in as SHA-256 hashes. */
export const users = {
  async create(db: Db, row: Omit<UserRecord, 'lastLoginAt'>): Promise<UserRecord> {
    const full = { ...row, email: row.email.toLowerCase(), lastLoginAt: null };
    db.orm.insert(t).values(full).run();
    return full;
  },

  async get(db: Db, id: string): Promise<UserRecord | undefined> {
    return db.orm.select().from(t).where(eq(t.id, id)).get();
  },

  async getByEmail(db: Db, email: string): Promise<UserRecord | undefined> {
    return db.orm.select().from(t).where(eq(t.email, email.toLowerCase())).get();
  },

  async getByOidc(db: Db, issuer: string, subject: string): Promise<UserRecord | undefined> {
    return db.orm
      .select()
      .from(t)
      .where(and(eq(t.oidcIssuer, issuer), eq(t.oidcSubject, subject)))
      .get();
  },

  async list(db: Db): Promise<UserRecord[]> {
    return db.orm.select().from(t).orderBy(t.createdAt).all();
  },

  async count(db: Db): Promise<number> {
    return db.orm.select({ n: count() }).from(t).get()?.n ?? 0;
  },

  /** Number of active admins other than `exceptId` (guards against removing the last admin). */
  async countActiveAdmins(db: Db, exceptId?: string): Promise<number> {
    const where = and(eq(t.role, 'admin'), eq(t.status, 'active'), exceptId ? ne(t.id, exceptId) : undefined);
    return db.orm.select({ n: count() }).from(t).where(where).get()?.n ?? 0;
  },

  async update(
    db: Db,
    id: string,
    patch: Partial<Pick<UserRecord, 'name' | 'role' | 'status' | 'passwordHash' | 'oidcIssuer' | 'oidcSubject' | 'lastLoginAt'>>,
  ): Promise<void> {
    if (Object.keys(patch).length > 0) db.orm.update(t).set(patch).where(eq(t.id, id)).run();
  },

  sessions: {
    async create(db: Db, row: SessionRecord): Promise<void> {
      db.orm.insert(ses).values(row).run();
    },
    async getByHash(db: Db, tokenHash: string): Promise<SessionRecord | undefined> {
      return db.orm.select().from(ses).where(eq(ses.tokenHash, tokenHash)).get();
    },
    async getByPrevHash(db: Db, tokenHash: string): Promise<SessionRecord | undefined> {
      return db.orm.select().from(ses).where(eq(ses.prevTokenHash, tokenHash)).get();
    },
    /** Replaces the token hash, keeping the old one valid as `prevTokenHash` until the next rotation. */
    async rotate(db: Db, id: string, next: { tokenHash: string; prevTokenHash: string; rotatedAt: string; expiresAt: string }): Promise<void> {
      db.orm.update(ses).set(next).where(eq(ses.id, id)).run();
    },
    async delete(db: Db, id: string): Promise<void> {
      db.orm.delete(ses).where(eq(ses.id, id)).run();
    },
    async deleteForUser(db: Db, userId: string): Promise<void> {
      db.orm.delete(ses).where(eq(ses.userId, userId)).run();
    },
    async deleteExpired(db: Db, now: string): Promise<void> {
      db.orm.delete(ses).where(lt(ses.expiresAt, now)).run();
    },
    async listForUser(db: Db, userId: string): Promise<SessionRecord[]> {
      return db.orm.select().from(ses).where(eq(ses.userId, userId)).all();
    },
  },

  invites: {
    async create(db: Db, row: Omit<InviteRecord, 'acceptedAt' | 'revokedAt'>): Promise<void> {
      db.orm.insert(inv).values({ ...row, email: row.email.toLowerCase(), acceptedAt: null, revokedAt: null }).run();
    },
    async get(db: Db, id: string): Promise<InviteRecord | undefined> {
      return db.orm.select().from(inv).where(eq(inv.id, id)).get();
    },
    async getByHash(db: Db, tokenHash: string): Promise<InviteRecord | undefined> {
      return db.orm.select().from(inv).where(eq(inv.tokenHash, tokenHash)).get();
    },
    /** Open (not accepted, not revoked) invite for an email, newest first. */
    async getOpenByEmail(db: Db, email: string, now: string): Promise<InviteRecord | undefined> {
      return db.orm
        .select()
        .from(inv)
        .where(and(eq(inv.email, email.toLowerCase()), isNull(inv.acceptedAt), isNull(inv.revokedAt)))
        .orderBy(desc(inv.createdAt))
        .all()
        .find((i) => i.expiresAt > now);
    },
    async listOpen(db: Db): Promise<InviteRecord[]> {
      return db.orm.select().from(inv).where(and(isNull(inv.acceptedAt), isNull(inv.revokedAt))).orderBy(desc(inv.createdAt)).all();
    },
    async markAccepted(db: Db, id: string, at: string): Promise<void> {
      db.orm.update(inv).set({ acceptedAt: at }).where(eq(inv.id, id)).run();
    },
    async revoke(db: Db, id: string, at: string): Promise<void> {
      db.orm.update(inv).set({ revokedAt: at }).where(eq(inv.id, id)).run();
    },
  },
};
export type UsersRepo = typeof users;
