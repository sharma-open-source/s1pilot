import { AuthSetupSchema, S1PilotError, newId, type AuthKind, type AuthSetup, type AuthStatus, type AuthValidation } from '@s1pilot/domain';
import { and, asc, eq } from 'drizzle-orm';

import type { Db } from '../db.js';
import { authSetups as t } from '../schema/index.js';

import { fromRow, nowIso } from './util.js';

/** Fields of a new auth setup. */
export interface NewAuthSetup {
  environmentId: string;
  name: string;
  kind: AuthKind;
  flowId?: string;
  validation?: AuthValidation;
}

type Row = typeof t.$inferSelect;

const toDomain = (row: Row): AuthSetup => {
  const { stateCiphertext, ...rest } = row;
  return fromRow(AuthSetupSchema, { ...rest, hasState: stateCiphertext !== null });
};

/** Auth setups. Storage states are encrypted with `db.crypto` on write and decrypted only by `getState`. */
export const authSetups = {
  async listByEnvironment(db: Db, environmentId: string): Promise<AuthSetup[]> {
    return db.orm.select().from(t).where(eq(t.environmentId, environmentId)).orderBy(asc(t.name)).all().map(toDomain);
  },

  async get(db: Db, id: string): Promise<AuthSetup | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && toDomain(row);
  },

  async getByName(db: Db, environmentId: string, name: string): Promise<AuthSetup | undefined> {
    const row = db.orm.select().from(t).where(and(eq(t.environmentId, environmentId), eq(t.name, name))).get();
    return row && toDomain(row);
  },

  /** Creates a setup, or updates kind / flow / validation of the existing one with the same name (state kept). */
  async upsert(db: Db, input: NewAuthSetup): Promise<AuthSetup> {
    const existing = await authSetups.getByName(db, input.environmentId, input.name);
    const fields = { kind: input.kind, flowId: input.flowId ?? null, validation: input.validation ?? null };
    if (existing) {
      db.orm.update(t).set(fields).where(eq(t.id, existing.id)).run();
      return (await authSetups.get(db, existing.id)) as AuthSetup;
    }
    const id = newId();
    db.orm.insert(t).values({ id, environmentId: input.environmentId, name: input.name, status: 'never', ...fields }).run();
    return (await authSetups.get(db, id)) as AuthSetup;
  },

  /** Stores a storage state (JSON string), encrypted, and marks the setup `valid`. */
  async saveState(db: Db, id: string, stateJson: string): Promise<AuthSetup> {
    db.orm
      .update(t)
      .set({ stateCiphertext: db.crypto.encrypt(stateJson), status: 'valid', lastRefreshedAt: nowIso() })
      .where(eq(t.id, id))
      .run();
    const setup = await authSetups.get(db, id);
    if (!setup) throw new S1PilotError('AUTH_NOT_FOUND', `Auth setup not found: ${id}`, { id });
    return setup;
  },

  /** Decrypted storage state JSON, if one is stored. */
  async getState(db: Db, id: string): Promise<string | undefined> {
    const row = db.orm.select({ c: t.stateCiphertext }).from(t).where(eq(t.id, id)).get();
    return row?.c ? db.crypto.decrypt(row.c) : undefined;
  },

  async setStatus(db: Db, id: string, status: AuthStatus): Promise<void> {
    db.orm.update(t).set({ status }).where(eq(t.id, id)).run();
  },

  async delete(db: Db, id: string): Promise<void> {
    db.orm.delete(t).where(eq(t.id, id)).run();
  },
};

export type AuthSetupsRepo = typeof authSetups;
