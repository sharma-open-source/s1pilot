import { SuiteSchema, type Suite } from '@s1pilot/domain';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';

import type { Db } from '../db.js';
import { suites as t } from '../schema/index.js';

import { fromRow, notFound } from './util.js';

export type SuiteInput = z.input<typeof SuiteSchema>;

/** Nestable test suites (folders). Deleting a suite cascades to its sub-suites. */
export const suites = {
  async create(db: Db, input: SuiteInput): Promise<Suite> {
    const suite = SuiteSchema.parse(input);
    db.orm.insert(t).values(suite).run();
    return this.get(db, suite.id) as Promise<Suite>;
  },

  async get(db: Db, id: string): Promise<Suite | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && fromRow(SuiteSchema, row);
  },

  async listByProject(db: Db, projectId: string): Promise<Suite[]> {
    return db.orm
      .select()
      .from(t)
      .where(eq(t.projectId, projectId))
      .orderBy(asc(t.position), asc(t.name))
      .all()
      .map((row) => fromRow(SuiteSchema, row));
  },

  async update(db: Db, id: string, patch: Partial<Pick<Suite, 'name' | 'parentId' | 'position'>>): Promise<Suite> {
    const existing = await this.get(db, id);
    if (!existing) return notFound('Suite', id);
    const merged = SuiteSchema.parse({ ...existing, ...patch });
    db.orm.update(t).set({ ...merged, parentId: merged.parentId ?? null }).where(eq(t.id, id)).run();
    return (await this.get(db, id)) as Suite;
  },

  async delete(db: Db, id: string): Promise<void> {
    db.orm.delete(t).where(eq(t.id, id)).run();
  },
};
export type SuitesRepo = typeof suites;
