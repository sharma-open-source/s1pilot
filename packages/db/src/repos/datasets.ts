import { TestDataSetSchema, type TestDataSet } from '@s1pilot/domain';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';

import type { Db } from '../db.js';
import { testDataSets as t } from '../schema/index.js';

import { fromRow } from './util.js';

export type TestDataSetInput = z.input<typeof TestDataSetSchema>;

/** Data set name without a `.csv` / `.json` extension (`addresses.csv` and `addresses` are the same set). */
export function datasetBaseName(name: string): string {
  return name.trim().replace(/\.(csv|json)$/i, '');
}

const scopeOf = (environmentId: string | undefined) => (environmentId === undefined ? isNull(t.environmentId) : eq(t.environmentId, environmentId));

/** Test data sets (CSV/JSON rows) of a project, shared or scoped to one environment. */
export const datasets = {
  async listByProject(db: Db, projectId: string): Promise<TestDataSet[]> {
    return db.orm
      .select()
      .from(t)
      .where(eq(t.projectId, projectId))
      .orderBy(asc(t.name))
      .all()
      .map((row) => fromRow(TestDataSetSchema, row));
  },

  /** Creates the set, or replaces the rows of the set with the same name and environment scope. */
  async upsert(db: Db, input: TestDataSetInput): Promise<TestDataSet> {
    const parsed = TestDataSetSchema.parse({ ...input, name: datasetBaseName(input.name) });
    const existing = db.orm
      .select()
      .from(t)
      .where(and(eq(t.projectId, parsed.projectId), eq(t.name, parsed.name), scopeOf(parsed.environmentId)))
      .get();
    if (existing) {
      db.orm.update(t).set({ rows: parsed.rows }).where(eq(t.id, existing.id)).run();
      return { ...parsed, id: existing.id };
    }
    db.orm.insert(t).values(parsed).run();
    return parsed;
  },

  /** Rows of a set by name (extension optional). An environment-specific set wins over the shared one. */
  async lookup(db: Db, projectId: string, name: string, environmentId?: string): Promise<TestDataSet | undefined> {
    const base = datasetBaseName(name);
    const sets = (await this.listByProject(db, projectId)).filter((s) => s.name === base);
    return (environmentId !== undefined ? sets.find((s) => s.environmentId === environmentId) : undefined) ?? sets.find((s) => s.environmentId === undefined);
  },

  /** Rows of every set usable in one environment, by name: an environment-specific set wins over the shared one. */
  async rowsForEnvironment(db: Db, projectId: string, environmentId: string): Promise<Record<string, TestDataSet['rows']>> {
    const out: Record<string, TestDataSet['rows']> = {};
    const sets = await this.listByProject(db, projectId);
    for (const set of sets) if (set.environmentId === undefined) out[set.name] = set.rows;
    for (const set of sets) if (set.environmentId === environmentId) out[set.name] = set.rows;
    return out;
  },

  async delete(db: Db, id: string): Promise<void> {
    db.orm.delete(t).where(eq(t.id, id)).run();
  },
};
export type DatasetsRepo = typeof datasets;
