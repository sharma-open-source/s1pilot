import { LearnedScriptSchema, type LearnedScript } from '@s1pilot/domain';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';

import type { Db } from '../db.js';
import { learnedScripts as t } from '../schema/index.js';

import { fromRow, nowIso } from './util.js';

export type LearnedScriptInput = z.input<typeof LearnedScriptSchema>;

/** Cached resolved actions, one script per (case, environment). */
export const learnedScripts = {
  /** Inserts the script, or replaces the existing one for the same case + environment. */
  async upsert(db: Db, input: LearnedScriptInput): Promise<LearnedScript> {
    const script = LearnedScriptSchema.parse(input);
    const values = { ...script, createdAt: script.createdAt ?? nowIso() };
    db.orm
      .insert(t)
      .values(values)
      .onConflictDoUpdate({
        target: [t.caseId, t.environmentId],
        set: {
          caseVersion: values.caseVersion,
          actions: values.actions,
          createdFromRunId: values.createdFromRunId,
          health: values.health,
          createdAt: values.createdAt,
        },
      })
      .run();
    return (await this.getFor(db, script.caseId, script.environmentId)) as LearnedScript;
  },

  async get(db: Db, id: string): Promise<LearnedScript | undefined> {
    const row = db.orm.select().from(t).where(eq(t.id, id)).get();
    return row && fromRow(LearnedScriptSchema, row);
  },

  async getFor(db: Db, caseId: string, environmentId: string): Promise<LearnedScript | undefined> {
    const row = db.orm
      .select()
      .from(t)
      .where(and(eq(t.caseId, caseId), eq(t.environmentId, environmentId)))
      .get();
    return row && fromRow(LearnedScriptSchema, row);
  },

  async listByCase(db: Db, caseId: string): Promise<LearnedScript[]> {
    return db.orm
      .select()
      .from(t)
      .where(eq(t.caseId, caseId))
      .orderBy(desc(t.createdAt))
      .all()
      .map((row) => fromRow(LearnedScriptSchema, row));
  },

  async delete(db: Db, id: string): Promise<void> {
    db.orm.delete(t).where(eq(t.id, id)).run();
  },
};
export type LearnedScriptsRepo = typeof learnedScripts;
