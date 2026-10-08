import { RequirementSchema, S1PilotError, newId, type Requirement } from '@s1pilot/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db.js';
import { caseRequirements as link, requirements as t } from '../schema/index.js';

import { notFound, nowIso, nullsToUndefined } from './util.js';

function load(db: Db, rows: (typeof t.$inferSelect)[]): Requirement[] {
  const ids = rows.map((r) => r.id);
  const links = ids.length > 0 ? db.orm.select().from(link).where(inArray(link.requirementId, ids)).all() : [];
  return rows.map((r) =>
    RequirementSchema.parse({
      ...nullsToUndefined(r),
      caseIds: links.filter((l) => l.requirementId === r.id).map((l) => l.caseId),
    }),
  );
}

/** Requirements and their links to test cases (`case_requirements`). */
export const requirements = {
  /** Creates a requirement; `CONFLICT` when the key exists in the project. */
  async create(db: Db, input: { projectId: string; key: string; title: string; description?: string }): Promise<Requirement> {
    if (db.orm.select().from(t).where(and(eq(t.projectId, input.projectId), eq(t.key, input.key))).get()) {
      throw new S1PilotError('CONFLICT', `Requirement ${input.key} already exists`, { key: input.key });
    }
    const id = newId();
    const ts = nowIso();
    db.orm
      .insert(t)
      .values({
        id,
        projectId: input.projectId,
        key: input.key,
        title: input.title,
        description: input.description ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return (await this.get(db, id)) as Requirement;
  },

  async get(db: Db, id: string): Promise<Requirement | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && load(db, [row])[0];
  },

  async getByKey(db: Db, projectId: string, key: string): Promise<Requirement | undefined> {
    const row = db.orm.select().from(t).where(and(eq(t.projectId, projectId), eq(t.key, key))).get();
    return row && load(db, [row])[0];
  },

  async listByProject(db: Db, projectId: string): Promise<Requirement[]> {
    return load(db, db.orm.select().from(t).where(eq(t.projectId, projectId)).orderBy(asc(t.key)).all());
  },

  /** Idempotent. */
  async link(db: Db, caseId: string, requirementId: string): Promise<void> {
    if (!db.orm.select().from(t).where(eq(t.id, requirementId)).get()) return notFound('Requirement', requirementId);
    db.orm.insert(link).values({ caseId, requirementId }).onConflictDoNothing().run();
  },

  async unlink(db: Db, caseId: string, requirementId: string): Promise<void> {
    db.orm.delete(link).where(and(eq(link.caseId, caseId), eq(link.requirementId, requirementId))).run();
  },
};
export type RequirementsRepo = typeof requirements;
