import { and, eq, inArray, lt } from 'drizzle-orm';

import { atomic, type Db } from '../db.js';
import { artifacts as art, evidence as ev } from '../schema/index.js';

import { nowIso } from './util.js';

/** Kinds of artifact (same values as `Evidence.kind`). */
export type ArtifactKind = typeof art.$inferSelect.kind;

/** A stored artifact's metadata. */
export interface ArtifactRecord {
  id: string;
  projectId: string;
  runId: string;
  caseResultId: string;
  stepIndex?: number;
  kind: ArtifactKind;
  name: string;
  contentType: string;
  size: number;
  /** Path relative to the store root. */
  path: string;
  createdAt: string;
}

export type NewArtifactRecord = Omit<ArtifactRecord, 'createdAt'> & { createdAt?: string };

const toRecord = (row: typeof art.$inferSelect): ArtifactRecord => {
  const { stepIndex, ...rest } = row;
  return { ...rest, ...(stepIndex !== null ? { stepIndex } : {}) };
};

/** Artifact metadata (the files themselves are handled by the artifact store). */
export const artifacts = {
  async create(db: Db, input: NewArtifactRecord): Promise<ArtifactRecord> {
    const row = { ...input, stepIndex: input.stepIndex ?? null, createdAt: input.createdAt ?? nowIso() };
    db.orm.insert(art).values(row).run();
    return toRecord(db.orm.select().from(art).where(eq(art.id, input.id)).get() as typeof art.$inferSelect);
  },

  async get(db: Db, id: string): Promise<ArtifactRecord | undefined> {
    const row = db.orm.select().from(art).where(eq(art.id, id)).get();
    return row && toRecord(row);
  },

  async listByCaseResult(db: Db, caseResultId: string): Promise<ArtifactRecord[]> {
    return db.orm.select().from(art).where(eq(art.caseResultId, caseResultId)).all().map(toRecord);
  },

  /** Artifacts of a project created before `olderThan` (ISO timestamp). */
  async listOlderThan(db: Db, projectId: string, olderThan: string): Promise<ArtifactRecord[]> {
    return db.orm
      .select()
      .from(art)
      .where(and(eq(art.projectId, projectId), lt(art.createdAt, olderThan)))
      .all()
      .map(toRecord);
  },

  /** Deletes artifact rows and the evidence rows that point at them. Returns the number of artifacts removed. */
  async deleteMany(db: Db, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    atomic(db, () => {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        db.orm.delete(ev).where(inArray(ev.artifactId, chunk)).run();
        db.orm.delete(art).where(inArray(art.id, chunk)).run();
      }
    });
    return ids.length;
  },

  /** Links an artifact to a step result as evidence (appended after existing evidence). */
  async linkEvidence(db: Db, input: { id: string; stepResultId: string; kind: ArtifactKind; artifactId: string }): Promise<void> {
    const position = db.orm.select().from(ev).where(eq(ev.stepResultId, input.stepResultId)).all().length;
    db.orm.insert(ev).values({ ...input, position }).run();
  },
};
export type ArtifactsRepo = typeof artifacts;
