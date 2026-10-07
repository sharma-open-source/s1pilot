import { eq } from 'drizzle-orm';

import type { Db } from '../db.js';
import { settings as t } from '../schema/index.js';

/** Key/value JSON settings (workspace-level model defaults, retention, …). */
export const settings = {
  /** Returns the stored JSON value, or `undefined` when the key is absent. */
  async get(db: Db, key: string): Promise<unknown> {
    return db.orm.select().from(t).where(eq(t.key, key)).get()?.value;
  },

  async set(db: Db, key: string, value: unknown): Promise<void> {
    db.orm.insert(t).values({ key, value }).onConflictDoUpdate({ target: t.key, set: { value } }).run();
  },

  async delete(db: Db, key: string): Promise<void> {
    db.orm.delete(t).where(eq(t.key, key)).run();
  },
};
export type SettingsRepo = typeof settings;
