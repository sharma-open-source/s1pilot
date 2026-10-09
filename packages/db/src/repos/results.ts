import {
  CaseResultSchema,
  DecisionRecordSchema,
  EvidenceSchema,
  StepResultSchema,
  newId,
  type CaseResult,
  type StepResult,
} from '@s1pilot/domain';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';

import { atomic, type Db } from '../db.js';
import {
  caseResults as cr,
  testRuns as tr,
  decisionRecords as dr,
  evidence as ev,
  stepResults as sr,
} from '../schema/index.js';

import { fromRow, notFound } from './util.js';

export type CaseResultInput = z.input<typeof CaseResultSchema>;
export type StepResultInput = z.input<typeof StepResultSchema>;

function loadStep(db: Db, row: typeof sr.$inferSelect): StepResult {
  const decisions = db.orm
    .select()
    .from(dr)
    .where(eq(dr.stepResultId, row.id))
    .orderBy(asc(dr.position))
    .all()
    .map((d) => fromRow(DecisionRecordSchema, d));
  const evidence = db.orm
    .select()
    .from(ev)
    .where(eq(ev.stepResultId, row.id))
    .orderBy(asc(ev.position))
    .all()
    .map((e) => fromRow(EvidenceSchema, e));
  return fromRow(StepResultSchema, { ...row, decisions, evidence });
}

/** Case results, step results, decision records and evidence. */
export const results = {
  async createCase(db: Db, input: CaseResultInput): Promise<CaseResult> {
    const result = CaseResultSchema.parse(input);
    db.orm.insert(cr).values(result).run();
    return (await this.getCase(db, result.id)) as CaseResult;
  },

  async getCase(db: Db, id: string): Promise<CaseResult | undefined> {
    const row = db.orm.select().from(cr).where(eq(cr.id, id)).get();
    return row && fromRow(CaseResultSchema, row);
  },

  async listCases(db: Db, runId: string): Promise<CaseResult[]> {
    return db.orm
      .select()
      .from(cr)
      .where(eq(cr.runId, runId))
      .all()
      .map((row) => fromRow(CaseResultSchema, row));
  },

  /**
   * Most recent result per case (by run start time, then attempt) for the given case ids.
   * Cases without results are absent from the map.
   */
  async lastByCases(db: Db, caseIds: string[]): Promise<Map<string, CaseResult & { startedAt?: string }>> {
    const out = new Map<string, CaseResult & { startedAt?: string }>();
    if (caseIds.length === 0) return out;
    const rows = db.orm
      .select({ r: cr, startedAt: tr.startedAt })
      .from(cr)
      .innerJoin(tr, eq(cr.runId, tr.id))
      .where(inArray(cr.caseId, caseIds))
      .orderBy(desc(tr.startedAt), desc(cr.attempt))
      .all();
    for (const { r, startedAt } of rows) {
      if (out.has(r.caseId)) continue;
      out.set(r.caseId, { ...fromRow(CaseResultSchema, r), ...(startedAt ? { startedAt } : {}) });
    }
    return out;
  },

  /**
   * Average case-result duration (ms) per execution mode in a project, over runs that have started
   * (`manual` results excluded). Modes without history are absent.
   */
  async avgDurationByMode(db: Db, projectId: string): Promise<Map<CaseResult['mode'], number>> {
    const rows = db.orm
      .select({ mode: cr.mode, avg: sql<number>`avg(${cr.durationMs})` })
      .from(cr)
      .innerJoin(tr, eq(cr.runId, tr.id))
      .where(eq(tr.projectId, projectId))
      .groupBy(cr.mode)
      .all();
    return new Map(rows.filter((r) => r.mode !== 'manual').map((r) => [r.mode, Number(r.avg)]));
  },

  async updateCase(db: Db, id: string, patch: Partial<Omit<CaseResultInput, 'id' | 'runId' | 'caseId'>>): Promise<CaseResult> {
    const existing = await this.getCase(db, id);
    if (!existing) return notFound('CaseResult', id);
    const merged = CaseResultSchema.parse({ ...existing, ...patch });
    db.orm
      .update(cr)
      .set({ ...merged, environmentId: merged.environmentId ?? null, browser: merged.browser ?? null, confidence: merged.confidence ?? null })
      .where(eq(cr.id, id))
      .run();
    return (await this.getCase(db, id)) as CaseResult;
  },

  /** Stores a step result with its decision records and evidence in one transaction. */
  async addStep(db: Db, input: StepResultInput): Promise<StepResult> {
    const step = StepResultSchema.parse(input);
    atomic(db, () => {
      const { decisions, evidence, ...row } = step;
      db.orm.insert(sr).values(row).run();
      decisions.forEach((d, position) => {
        db.orm.insert(dr).values({ ...d, id: newId(), stepResultId: step.id, position }).run();
      });
      evidence.forEach((e, position) => {
        db.orm.insert(ev).values({ ...e, id: newId(), stepResultId: step.id, position }).run();
      });
    });
    return (await this.getStep(db, step.id)) as StepResult;
  },

  async getStep(db: Db, id: string): Promise<StepResult | undefined> {
    const row = db.orm.select().from(sr).where(eq(sr.id, id)).get();
    return row && loadStep(db, row);
  },

  async listSteps(db: Db, caseResultId: string): Promise<StepResult[]> {
    return db.orm
      .select()
      .from(sr)
      .where(eq(sr.caseResultId, caseResultId))
      .orderBy(asc(sr.stepIndex))
      .all()
      .map((row) => loadStep(db, row));
  },
};
export type ResultsRepo = typeof results;
