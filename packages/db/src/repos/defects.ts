import { DefectSchema, type Defect } from '@s1pilot/domain';
import { desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';

import { atomic, type Db } from '../db.js';
import { caseResults, defectResults as links, defects as t } from '../schema/index.js';

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
    seq: defect.seq ?? null,
    details: defect.details ?? null,
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
      if (defect.seq === undefined) {
        const max = db.orm
          .select({ m: sql<number | null>`max(${t.seq})` })
          .from(t)
          .where(eq(t.projectId, defect.projectId))
          .get();
        defect.seq = (max?.m ?? 0) + 1;
      }
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

  /** Defects linked to a case result, newest first. */
  async listByResult(db: Db, caseResultId: string): Promise<Defect[]> {
    return db.orm
      .select({ d: t })
      .from(links)
      .innerJoin(t, eq(links.defectId, t.id))
      .where(eq(links.caseResultId, caseResultId))
      .orderBy(desc(t.createdAt))
      .all()
      .map((r) => load(db, r.d));
  },

  /** Verdicts of the results linked to a defect (for "failing results" and re-test targeting). */
  async linkedResults(db: Db, defectId: string) {
    return db.orm
      .select({ r: caseResults })
      .from(links)
      .innerJoin(caseResults, eq(links.caseResultId, caseResults.id))
      .where(eq(links.defectId, defectId))
      .all()
      .map((x) => x.r);
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
