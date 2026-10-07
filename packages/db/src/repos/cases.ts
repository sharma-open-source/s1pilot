import {
  IdSchema,
  TestCaseFileSchema,
  TestCaseSchema,
  caseKey,
  newId,
  type Priority,
  type TestCase,
  type TestCaseStatus,
  type TestCaseType,
} from '@s1pilot/domain';
import { and, desc, eq, like, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';

import { atomic, type Db } from '../db.js';
import { projects, testCaseVersions as versions, testCases as t } from '../schema/index.js';

import { fromRow, notFound, nowIso } from './util.js';

/** Case content without the key, which is allocated per project (`SHOP-TC-n`). */
export const NewTestCaseSchema = TestCaseFileSchema.omit({ key: true }).extend({
  suiteId: IdSchema.optional(),
});
export type NewTestCase = z.input<typeof NewTestCaseSchema>;

export interface CaseFilters {
  projectId: string;
  suiteId?: string;
  status?: TestCaseStatus;
  priority?: Priority;
  type?: TestCaseType;
  tag?: string;
  /** Matches title or key. */
  search?: string;
  limit?: number;
  offset?: number;
}

/** Test cases. Every create/update writes a full snapshot to `test_case_versions`. */
export const cases = {
  /**
   * Creates a case, allocating the next `KEY-TC-n` for the project atomically
   * (better-sqlite3 is synchronous, so concurrent callers in one process cannot interleave).
   */
  async create(db: Db, projectId: string, input: NewTestCase): Promise<TestCase> {
    const data = NewTestCaseSchema.parse(input);
    const id = newId();
    atomic(db, () => {
      const project = db.orm.select().from(projects).where(eq(projects.id, projectId)).get();
      if (!project) return notFound('Project', projectId);
      const number = project.nextCaseNumber;
      const ts = nowIso();
      db.orm.update(projects).set({ nextCaseNumber: number + 1 }).where(eq(projects.id, projectId)).run();
      db.orm
        .insert(t)
        .values({ ...data, id, projectId, key: caseKey(project.key, number), number, version: 1, createdAt: ts, updatedAt: ts })
        .run();
      snapshot(db, id);
    });
    return (await this.get(db, id)) as TestCase;
  },

  async get(db: Db, id: string): Promise<TestCase | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && fromRow(TestCaseSchema, row);
  },

  async getByKey(db: Db, key: string): Promise<TestCase | undefined> {
    const row = db.orm.select().from(t).where(eq(t.key, key)).get();
    return row && fromRow(TestCaseSchema, row);
  },

  async list(db: Db, filters: CaseFilters): Promise<TestCase[]> {
    const conditions: SQL[] = [eq(t.projectId, filters.projectId)];
    if (filters.suiteId) conditions.push(eq(t.suiteId, filters.suiteId));
    if (filters.status) conditions.push(eq(t.status, filters.status));
    if (filters.priority) conditions.push(eq(t.priority, filters.priority));
    if (filters.type) conditions.push(eq(t.type, filters.type));
    if (filters.tag) {
      conditions.push(sql`exists (select 1 from json_each(${t.tags}) where value = ${filters.tag})`);
    }
    if (filters.search) {
      const pattern = `%${filters.search}%`;
      const match = or(like(t.title, pattern), like(t.key, pattern));
      if (match) conditions.push(match);
    }
    return db.orm
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(t.number)
      .limit(filters.limit ?? -1)
      .offset(filters.offset ?? 0)
      .all()
      .map((row) => fromRow(TestCaseSchema, row));
  },

  /**
   * Applies `patch`, bumps `version` and stores a snapshot of the new version.
   * The key, project and version cannot be patched.
   */
  async update(db: Db, id: string, patch: Partial<z.input<typeof NewTestCaseSchema>>): Promise<TestCase> {
    const existing = await this.get(db, id);
    if (!existing) return notFound('TestCase', id);
    const merged = TestCaseSchema.parse({
      ...existing,
      ...patch,
      id,
      projectId: existing.projectId,
      key: existing.key,
      version: existing.version + 1,
    });
    atomic(db, () => {
      db.orm
        .update(t)
        .set({ ...merged, suiteId: merged.suiteId ?? null, owner: merged.owner ?? null, updatedAt: nowIso() })
        .where(eq(t.id, id))
        .run();
      snapshot(db, id);
    });
    return (await this.get(db, id)) as TestCase;
  },

  /** All versions of a case, newest first (the first entry is the current version). */
  async history(db: Db, id: string): Promise<TestCase[]> {
    return db.orm
      .select()
      .from(versions)
      .where(eq(versions.caseId, id))
      .orderBy(desc(versions.version))
      .all()
      .map((row) => TestCaseSchema.parse(row.snapshot));
  },

  /** The number the next case in this project will receive (does not consume it). */
  async nextCaseNumber(db: Db, projectId: string): Promise<number> {
    const row = db.orm.select({ n: projects.nextCaseNumber }).from(projects).where(eq(projects.id, projectId)).get();
    return row ? row.n : notFound('Project', projectId);
  },

  async delete(db: Db, id: string): Promise<void> {
    db.orm.delete(t).where(eq(t.id, id)).run();
  },
};
export type CasesRepo = typeof cases;

/** Writes the current row of `id` as a version snapshot. */
function snapshot(db: Db, id: string): void {
  const row = db.orm.select().from(t).where(eq(t.id, id)).get();
  if (!row) return notFound('TestCase', id);
  const current = fromRow(TestCaseSchema, row);
  db.orm
    .insert(versions)
    .values({ id: newId(), caseId: id, version: current.version, snapshot: current, createdAt: nowIso() })
    .run();
}
