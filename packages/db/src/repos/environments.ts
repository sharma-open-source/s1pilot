import { EnvironmentSchema, newId, type Environment, type Variable } from '@s1pilot/domain';
import { and, asc, eq } from 'drizzle-orm';
import type { z } from 'zod';

import { atomic, type Db } from '../db.js';
import { environments as t, variables as v } from '../schema/index.js';

import { fromRow, notFound } from './util.js';

export type EnvironmentInput = z.input<typeof EnvironmentSchema>;

function insertVariables(db: Db, environmentId: string, vars: Variable[], keep: Map<string, string>) {
  for (const variable of vars) {
    // Secret plaintext is encrypted and never written to the `value` column.
    const ciphertext = variable.secret
      ? variable.value !== undefined
        ? db.crypto.encrypt(variable.value)
        : (keep.get(variable.key) ?? null)
      : null;
    db.orm
      .insert(v)
      .values({
        id: newId(),
        environmentId,
        key: variable.key,
        value: variable.secret ? null : (variable.value ?? null),
        secret: variable.secret,
        secretCiphertext: ciphertext,
        source: variable.source,
        envVar: variable.envVar ?? null,
      })
      .run();
  }
}

function load(db: Db, id: string): Environment | undefined {
  const row = db.orm.select().from(t).where(eq(t.id, id)).get();
  if (!row) return undefined;
  const vars = db.orm
    .select()
    .from(v)
    .where(eq(v.environmentId, id))
    .orderBy(asc(v.key))
    .all()
    // Secret values are never returned, only their key and flag.
    .map(({ key, value, secret, source, envVar }) => ({
      key,
      value: secret ? undefined : (value ?? undefined),
      secret,
      source,
      envVar: envVar ?? undefined,
    }));
  return fromRow(EnvironmentSchema, { ...row, variables: vars });
}

/** Environments and their variables. Secret values are encrypted at rest and never read back. */
export const environments = {
  async create(db: Db, input: EnvironmentInput): Promise<Environment> {
    const env = EnvironmentSchema.parse(input);
    atomic(db, () => {
      const { variables: vars, ...row } = env;
      db.orm.insert(t).values(row).run();
      insertVariables(db, env.id, vars, new Map());
    });
    return load(db, env.id) as Environment;
  },

  async get(db: Db, id: string): Promise<Environment | undefined> {
    return load(db, id);
  },

  async listByProject(db: Db, projectId: string): Promise<Environment[]> {
    const rows = db.orm.select({ id: t.id }).from(t).where(eq(t.projectId, projectId)).orderBy(asc(t.name)).all();
    return rows.map((r) => load(db, r.id) as Environment);
  },

  /** Merges `patch`; when `variables` is given it replaces the set (secrets without a new value keep theirs). */
  async update(db: Db, id: string, patch: Partial<Omit<EnvironmentInput, 'id' | 'projectId'>>): Promise<Environment> {
    const existing = load(db, id);
    if (!existing) return notFound('Environment', id);
    const merged = EnvironmentSchema.parse({ ...existing, ...patch, id, projectId: existing.projectId });
    atomic(db, () => {
      const { variables: vars, ...row } = merged;
      db.orm.update(t).set({ ...row, authSetupFlowId: row.authSetupFlowId ?? null }).where(eq(t.id, id)).run();
      if (patch.variables !== undefined) {
        const keep = new Map(
          db.orm
            .select()
            .from(v)
            .where(eq(v.environmentId, id))
            .all()
            .flatMap((r) => (r.secretCiphertext !== null ? [[r.key, r.secretCiphertext] as const] : [])),
        );
        db.orm.delete(v).where(eq(v.environmentId, id)).run();
        insertVariables(db, id, vars, keep);
      }
    });
    return load(db, id) as Environment;
  },

  async delete(db: Db, id: string): Promise<void> {
    db.orm.delete(t).where(eq(t.id, id)).run();
  },

  /** Encrypted values of an environment's inline secret variables, by key (input for `resolveVariables`). */
  async secretCiphertexts(db: Db, environmentId: string): Promise<Record<string, string>> {
    const rows = db.orm.select().from(v).where(and(eq(v.environmentId, environmentId), eq(v.secret, true))).all();
    return Object.fromEntries(rows.flatMap((r) => (r.secretCiphertext ? [[r.key, r.secretCiphertext] as const] : [])));
  },

  /** Decrypts one secret variable for the runner. Never log the result. */
  async getSecret(db: Db, environmentId: string, key: string): Promise<string | undefined> {
    const row = db.orm
      .select({ c: v.secretCiphertext })
      .from(v)
      .where(and(eq(v.environmentId, environmentId), eq(v.key, key), eq(v.secret, true)))
      .get();
    return row?.c ? db.crypto.decrypt(row.c) : undefined;
  },
};
export type EnvironmentsRepo = typeof environments;
