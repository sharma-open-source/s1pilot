import { ManualItemSchema, type ManualItem } from '@s1pilot/domain';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';

import type { Db } from '../db.js';
import { manualItems as t } from '../schema/index.js';

import { fromRow, notFound } from './util.js';

export type ManualItemInput = z.input<typeof ManualItemSchema>;

/** Artifact owner id used for uploads made before the item has a case result. */
export const manualArtifactOwner = (itemId: string): string => `manual-${itemId}`;

/** Manual / hybrid execution items (S-055). */
export const manual = {
  async create(db: Db, input: ManualItemInput): Promise<ManualItem> {
    const item = ManualItemSchema.parse(input);
    db.orm.insert(t).values(item).run();
    return (await this.get(db, item.id)) as ManualItem;
  },

  async get(db: Db, id: string): Promise<ManualItem | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && fromRow(ManualItemSchema, row);
  },

  /** Items of one run in execution order. */
  async listByRun(db: Db, runId: string): Promise<ManualItem[]> {
    return db.orm
      .select()
      .from(t)
      .where(eq(t.runId, runId))
      .orderBy(asc(t.position))
      .all()
      .map((row) => fromRow(ManualItemSchema, row));
  },

  /** A user's items in one run, in execution order. */
  async listByRunAndAssignee(db: Db, runId: string, assignee: string): Promise<ManualItem[]> {
    return db.orm
      .select()
      .from(t)
      .where(and(eq(t.runId, runId), eq(t.assignee, assignee)))
      .orderBy(asc(t.position))
      .all()
      .map((row) => fromRow(ManualItemSchema, row));
  },

  /** A user's items (all statuses), oldest first; limited to one project when `projectId` is given. */
  async listByAssignee(db: Db, assignee: string, projectId?: string): Promise<ManualItem[]> {
    return db.orm
      .select()
      .from(t)
      .where(projectId ? and(eq(t.projectId, projectId), eq(t.assignee, assignee)) : eq(t.assignee, assignee))
      .orderBy(asc(t.runId), asc(t.position))
      .all()
      .map((row) => fromRow(ManualItemSchema, row));
  },

  /** Number of items of a run that are not finished (`todo` / `in-progress`). */
  async countOpenByRun(db: Db, runId: string): Promise<number> {
    return db.orm
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.runId, runId), inArray(t.status, ['todo', 'in-progress'])))
      .all().length;
  },

  async update(db: Db, id: string, patch: Partial<Omit<ManualItemInput, 'id' | 'projectId' | 'runId' | 'caseId'>>): Promise<ManualItem> {
    const existing = await this.get(db, id);
    if (!existing) return notFound('ManualItem', id);
    const merged = ManualItemSchema.parse({ ...existing, ...patch });
    db.orm
      .update(t)
      .set({
        ...merged,
        environmentId: merged.environmentId ?? null,
        browser: merged.browser ?? null,
        device: merged.device ?? null,
        timerStartedAt: merged.timerStartedAt ?? null,
        startedAt: merged.startedAt ?? null,
        finishedAt: merged.finishedAt ?? null,
        caseResultId: merged.caseResultId ?? null,
      })
      .where(eq(t.id, id))
      .run();
    return (await this.get(db, id)) as ManualItem;
  },

  /** Points the artifacts uploaded for an item at its case result. */
  async adoptArtifacts(db: Db, itemId: string, caseResultId: string): Promise<void> {
    db.sqlite.prepare('UPDATE artifacts SET case_result_id = ? WHERE case_result_id = ?').run(caseResultId, manualArtifactOwner(itemId));
  },
};
export type ManualRepo = typeof manual;
