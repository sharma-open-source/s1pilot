import { TestRunSchema, type TestRun } from '@s1pilot/domain';
import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';

import type { Db } from '../db.js';
import { testRuns as t } from '../schema/index.js';

import { fromRow, notFound } from './util.js';

export type RunInput = z.input<typeof TestRunSchema>;

/** Test runs. Case/step results live in the `results` repo. */
export const runs = {
  async create(db: Db, input: RunInput): Promise<TestRun> {
    const run = TestRunSchema.parse(input);
    db.orm.insert(t).values(run).run();
    return (await this.get(db, run.id)) as TestRun;
  },

  async get(db: Db, id: string): Promise<TestRun | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && fromRow(TestRunSchema, row);
  },

  /** Newest first by start time (queued runs without one come last). */
  async listByProject(db: Db, projectId: string, limit = 50): Promise<TestRun[]> {
    return db.orm
      .select()
      .from(t)
      .where(eq(t.projectId, projectId))
      .orderBy(desc(t.startedAt))
      .limit(limit)
      .all()
      .map((row) => fromRow(TestRunSchema, row));
  },

  /** Runs created from a plan, newest first. */
  async listByPlan(db: Db, planId: string, limit = 20): Promise<TestRun[]> {
    return db.orm
      .select()
      .from(t)
      .where(eq(t.planId, planId))
      .orderBy(desc(t.startedAt))
      .limit(limit)
      .all()
      .map((row) => fromRow(TestRunSchema, row));
  },

  async update(db: Db, id: string, patch: Partial<Omit<RunInput, 'id' | 'projectId'>>): Promise<TestRun> {
    const existing = await this.get(db, id);
    if (!existing) return notFound('TestRun', id);
    const merged = TestRunSchema.parse({ ...existing, ...patch });
    db.orm
      .update(t)
      .set({
        ...merged,
        planId: merged.planId ?? null,
        buildRef: merged.buildRef ?? null,
        startedAt: merged.startedAt ?? null,
        finishedAt: merged.finishedAt ?? null,
      })
      .where(eq(t.id, id))
      .run();
    return (await this.get(db, id)) as TestRun;
  },

  async delete(db: Db, id: string): Promise<void> {
    db.orm.delete(t).where(eq(t.id, id)).run();
  },
};
export type RunsRepo = typeof runs;
