import { DefectSchema, type Defect } from '@s1pilot/domain';
import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';

import { atomic, type Db } from '../db.js';
import { defectResults as links, defects as t } from '../schema/index.js';

import { fromRow, notFound, nowIso } from './util.js';

export type DefectInput = z.input<typeof DefectSchema>;

type Row = typeof t.$inferSelect;

function load(db: Db, row: Row): Defect {
  const linkedResultIds = db.orm
    .select({ id: links.caseResultId })
    .from(links)
    .where(eq(links.defectId, row.id))
    .all()
    .map((r) => r.id);
  const { externalProvider, externalId, externalUrl, ...rest } = row;
  const external =
    externalProvider && externalId
      ? { provider: externalProvider, id: externalId, ...(externalUrl ? { url: externalUrl } : {}) }
      : undefined;
  return fromRow(DefectSchema, { ...rest, linkedResultIds, external });
}

/** Domain defect → table columns (external tracker ref flattened; links live in `defect_results`). */
function flatten(defect: Defect) {
  const { external } = defect;
  return {
    id: defect.id,
    projectId: defect.projectId,
    title: defect.title,
    description: defect.description ?? null,
    severity: defect.severity,
    status: defect.status,
    externalProvider: external?.provider ?? null,
    externalId: external?.id ?? null,
    externalUrl: external?.url ?? null,
  };
}

/** Defects and their links to case results. */
export const defects = {
  async create(db: Db, input: DefectInput): Promise<Defect> {
    const defect = DefectSchema.parse(input);
    const ts = nowIso();
    atomic(db, () => {
      db.orm
        .insert(t)
        .values({ ...flatten(defect), createdAt: defect.createdAt ?? ts, updatedAt: defect.updatedAt ?? ts })
        .run();
      for (const caseResultId of defect.linkedResultIds) {
        db.orm.insert(links).values({ defectId: defect.id, caseResultId }).run();
      }
    });
    return (await this.get(db, defect.id)) as Defect;
  },

  async get(db: Db, id: string): Promise<Defect | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && load(db, row);
  },

  async listByProject(db: Db, projectId: string): Promise<Defect[]> {
    return db.orm
      .select()
      .from(t)
      .where(eq(t.projectId, projectId))
      .orderBy(desc(t.createdAt))
      .all()
      .map((row) => load(db, row));
  },

  async update(db: Db, id: string, patch: Partial<Omit<DefectInput, 'id' | 'projectId' | 'linkedResultIds'>>): Promise<Defect> {
    const existing = await this.get(db, id);
    if (!existing) return notFound('Defect', id);
    const merged = DefectSchema.parse({ ...existing, ...patch });
    db.orm
      .update(t)
      .set({ ...flatten(merged), updatedAt: nowIso() })
      .where(eq(t.id, id))
      .run();
    return (await this.get(db, id)) as Defect;
  },

  /** Links a defect to a case result (idempotent). */
  async link(db: Db, defectId: string, caseResultId: string): Promise<void> {
    db.orm.insert(links).values({ defectId, caseResultId }).onConflictDoNothing().run();
  },

  async delete(db: Db, id: string): Promise<void> {
    db.orm.delete(t).where(eq(t.id, id)).run();
  },
};
export type DefectsRepo = typeof defects;
