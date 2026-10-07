import {
  HealProposalSchema,
  ReviewItemSchema,
  type HealProposal,
  type ReviewItem,
  type ReviewStatus,
} from '@s1pilot/domain';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { z } from 'zod';

import type { Db } from '../db.js';
import { healProposals as hp, reviewItems as ri } from '../schema/index.js';

import { fromRow, notFound, nowIso } from './util.js';

export type ReviewItemInput = z.input<typeof ReviewItemSchema>;
export type HealProposalInput = z.input<typeof HealProposalSchema>;

/** Review queue items and heal proposals. */
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

  async createHealProposal(db: Db, input: HealProposalInput): Promise<HealProposal> {
    const proposal = HealProposalSchema.parse(input);
    db.orm.insert(hp).values({ ...proposal, createdAt: proposal.createdAt ?? nowIso() }).run();
    return (await this.getHealProposal(db, proposal.id)) as HealProposal;
  },

  async getHealProposal(db: Db, id: string): Promise<HealProposal | undefined> {
    const row = db.orm.select().from(hp).where(eq(hp.id, id)).get();
    return row && fromRow(HealProposalSchema, row);
  },

  async listHealProposals(db: Db, learnedScriptId: string, status?: ReviewStatus): Promise<HealProposal[]> {
    const where = status
      ? and(eq(hp.learnedScriptId, learnedScriptId), eq(hp.status, status))
      : eq(hp.learnedScriptId, learnedScriptId);
    return db.orm
      .select()
      .from(hp)
      .where(where)
      .orderBy(desc(hp.createdAt))
      .all()
      .map((row) => fromRow(HealProposalSchema, row));
  },

  async resolveHealProposal(db: Db, id: string, status: Exclude<ReviewStatus, 'pending'>): Promise<HealProposal> {
    if (!(await this.getHealProposal(db, id))) return notFound('HealProposal', id);
    db.orm.update(hp).set({ status }).where(eq(hp.id, id)).run();
    return (await this.getHealProposal(db, id)) as HealProposal;
  },
};
export type ReviewsRepo = typeof reviews;
