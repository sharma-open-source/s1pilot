import {
  ReviewItemSchema,
  type ReviewItem,
  type ReviewStatus,
} from '@s1pilot/domain';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { z } from 'zod';

import type { Db } from '../db.js';
import { reviewItems as ri } from '../schema/index.js';

import { fromRow, notFound, nowIso } from './util.js';

export type ReviewItemInput = z.input<typeof ReviewItemSchema>;

/** Review queue items (heal proposals live in `healProposals`). */
export const reviews = {
  async create(db: Db, input: ReviewItemInput): Promise<ReviewItem> {
    const item = ReviewItemSchema.parse(input);
    db.orm.insert(ri).values({ ...item, createdAt: item.createdAt ?? nowIso() }).run();
    return (await this.get(db, item.id)) as ReviewItem;
  },

  async get(db: Db, id: string): Promise<ReviewItem | undefined> {
    const row = db.orm.select().from(ri).where(eq(ri.id, id)).get();
    return row && fromRow(ReviewItemSchema, row);
  },

  async list(db: Db, filter: { projectId: string; status?: ReviewStatus; kind?: ReviewItem['kind'] }): Promise<ReviewItem[]> {
    const conditions: SQL[] = [eq(ri.projectId, filter.projectId)];
    if (filter.status) conditions.push(eq(ri.status, filter.status));
    if (filter.kind) conditions.push(eq(ri.kind, filter.kind));
    return db.orm
      .select()
      .from(ri)
      .where(and(...conditions))
      .orderBy(desc(ri.createdAt))
      .all()
      .map((row) => fromRow(ReviewItemSchema, row));
  },

  /** Marks an item approved or rejected. */
  async resolve(db: Db, id: string, status: Exclude<ReviewStatus, 'pending'>, note?: string): Promise<ReviewItem> {
    if (!(await this.get(db, id))) return notFound('ReviewItem', id);
    db.orm
      .update(ri)
      .set({ status, resolvedAt: nowIso(), ...(note !== undefined ? { note } : {}) })
      .where(eq(ri.id, id))
      .run();
    return (await this.get(db, id)) as ReviewItem;
  },
};
export type ReviewsRepo = typeof reviews;
