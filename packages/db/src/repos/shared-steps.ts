import { SharedStepSchema, type SharedStep } from '@s1pilot/domain';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';

import type { Db } from '../db.js';
import { sharedSteps as t } from '../schema/index.js';

import { fromRow, notFound } from './util.js';

export type SharedStepInput = z.input<typeof SharedStepSchema>;

/** Reusable step sequences ("flows"). */
export const sharedSteps = {
  async create(db: Db, input: SharedStepInput): Promise<SharedStep> {
    const step = SharedStepSchema.parse(input);
    db.orm.insert(t).values(step).run();
    return step;
  },

  async get(db: Db, id: string): Promise<SharedStep | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && fromRow(SharedStepSchema, row);
  },

  async listByProject(db: Db, projectId: string): Promise<SharedStep[]> {
    return db.orm
      .select()
      .from(t)
      .where(eq(t.projectId, projectId))
      .orderBy(asc(t.name))
      .all()
      .map((row) => fromRow(SharedStepSchema, row));
  },

  async update(db: Db, id: string, patch: Partial<Omit<SharedStepInput, 'id' | 'projectId'>>): Promise<SharedStep> {
    const existing = await this.get(db, id);
    if (!existing) return notFound('SharedStep', id);
    const merged = SharedStepSchema.parse({ ...existing, ...patch });
    db.orm.update(t).set(merged).where(eq(t.id, id)).run();
    return merged;
  },

  async delete(db: Db, id: string): Promise<void> {
    db.orm.delete(t).where(eq(t.id, id)).run();
  },
};
export type SharedStepsRepo = typeof sharedSteps;
