import { TestPlanSchema, type TestPlan } from '@s1pilot/domain';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';

import type { Db } from '../db.js';
import { testPlans as t } from '../schema/index.js';

import { fromRow, notFound, nowIso } from './util.js';

export type PlanInput = z.input<typeof TestPlanSchema>;

/** Test plans. */
export const plans = {
  async create(db: Db, input: PlanInput): Promise<TestPlan> {
    const plan = TestPlanSchema.parse(input);
    const ts = nowIso();
    db.orm
      .insert(t)
      .values({ ...plan, createdAt: plan.createdAt ?? ts, updatedAt: plan.updatedAt ?? ts })
      .run();
    return (await this.get(db, plan.id)) as TestPlan;
  },

  async get(db: Db, id: string): Promise<TestPlan | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && fromRow(TestPlanSchema, row);
  },

  async listByProject(db: Db, projectId: string): Promise<TestPlan[]> {
    return db.orm
      .select()
      .from(t)
      .where(eq(t.projectId, projectId))
      .orderBy(asc(t.name))
      .all()
      .map((row) => fromRow(TestPlanSchema, row));
  },

  async update(db: Db, id: string, patch: Partial<Omit<PlanInput, 'id' | 'projectId'>>): Promise<TestPlan> {
    const existing = await this.get(db, id);
    if (!existing) return notFound('TestPlan', id);
    const merged = TestPlanSchema.parse({ ...existing, ...patch });
    db.orm
      .update(t)
      .set({ ...merged, release: merged.release ?? null, schedule: merged.schedule ?? null, updatedAt: nowIso() })
      .where(eq(t.id, id))
      .run();
    return (await this.get(db, id)) as TestPlan;
  },

  async delete(db: Db, id: string): Promise<void> {
    db.orm.delete(t).where(eq(t.id, id)).run();
  },
};
export type PlansRepo = typeof plans;
