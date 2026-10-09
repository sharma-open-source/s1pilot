import { desc, eq } from 'drizzle-orm';

import type { Db } from '../db.js';
import { apiTokens as t } from '../schema/index.js';

/** A stored API token row. `hash` is never returned to clients. */
export interface ApiTokenRecord {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  scopes: string[];
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** API token persistence (hashes only). */
export const apiTokens = {
  async create(db: Db, row: Omit<ApiTokenRecord, 'lastUsedAt' | 'revokedAt'>): Promise<void> {
    db.orm.insert(t).values({ ...row, lastUsedAt: null, revokedAt: null }).run();
  },

  async list(db: Db): Promise<ApiTokenRecord[]> {
    return db.orm.select().from(t).orderBy(desc(t.createdAt)).all();
  },

  async getByPrefix(db: Db, prefix: string): Promise<ApiTokenRecord | undefined> {
    return db.orm.select().from(t).where(eq(t.prefix, prefix)).get();
  },

  async get(db: Db, id: string): Promise<ApiTokenRecord | undefined> {
    return db.orm.select().from(t).where(eq(t.id, id)).get();
  },

  async revoke(db: Db, id: string, at: string): Promise<void> {
    db.orm.update(t).set({ revokedAt: at }).where(eq(t.id, id)).run();
  },

  async touch(db: Db, id: string, at: string): Promise<void> {
    db.orm.update(t).set({ lastUsedAt: at }).where(eq(t.id, id)).run();
  },
};
export type ApiTokensRepo = typeof apiTokens;
