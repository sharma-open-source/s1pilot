import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';
import { BrowserNameSchema } from './environment.js';
import type { StepResult, Verdict } from './run.js';

/** Verdict a tester records for one manual step. */
export const ManualStepVerdictSchema = z.enum(['pass', 'fail', 'blocked', 'na']);
export type ManualStepVerdict = z.infer<typeof ManualStepVerdictSchema>;

/** Per-case assignment in a plan: who executes it and whether it is manual / hybrid (S-055). */
export const PlanAssignmentSchema = z.object({
  /** Mark the case as manual in this plan: runs create a manual session item instead of an automated job. */
  manual: z.boolean().default(false),
  /** User id the item is assigned to (local mode: the single user). */
  assignee: z.string().min(1).optional(),
  /** Let the AI pre-run the steps first (hybrid); the tester confirms or redoes them. */
  hybrid: z.boolean().default(false),
});
export type PlanAssignment = z.infer<typeof PlanAssignmentSchema>;

/** What the tester recorded for one step. `verdict` is absent while only attachments were added. */
export const ManualStepRecordSchema = z.object({
  stepIndex: z.number().int().min(0),
  verdict: ManualStepVerdictSchema.optional(),
  actual: z.string().default(''),
  /** Artifact ids (screenshots / videos) uploaded for this step. */
  attachments: z.array(IdSchema).default([]),
});
export type ManualStepRecord = z.infer<typeof ManualStepRecordSchema>;

export const ManualItemStatusSchema = z.enum(['todo', 'in-progress', 'done', 'skipped']);
export type ManualItemStatus = z.infer<typeof ManualItemStatusSchema>;

/** One manual execution of a case (one row of a user's queue). */
export const ManualItemSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  runId: IdSchema,
  caseId: IdSchema,
  environmentId: IdSchema.optional(),
  browser: BrowserNameSchema.optional(),
  device: z.string().optional(),
  assignee: z.string().min(1),
  hybrid: z.boolean().default(false),
  /** Order inside the run. */
  position: z.number().int().min(0).default(0),
  status: ManualItemStatusSchema.default('todo'),
  steps: z.array(ManualStepRecordSchema).default([]),
  /** Steps whose AI pre-run result the tester confirmed (hybrid). */
  confirmedSteps: z.array(z.number().int().min(0)).default([]),
  notes: z.string().default(''),
  /** Time spent so far, excluding the running stretch. */
  elapsedMs: z.number().min(0).default(0),
  /** Set while the timer runs. */
  timerStartedAt: IsoTimestampSchema.optional(),
  startedAt: IsoTimestampSchema.optional(),
  finishedAt: IsoTimestampSchema.optional(),
  caseResultId: IdSchema.optional(),
});
export type ManualItem = z.infer<typeof ManualItemSchema>;

/** Milliseconds on the item's timer at `now` (persisted elapsed time plus the running stretch). */
export function manualElapsedMs(item: Pick<ManualItem, 'elapsedMs' | 'timerStartedAt'>, now: Date = new Date()): number {
  if (!item.timerStartedAt) return item.elapsedMs;
  return item.elapsedMs + Math.max(0, now.getTime() - new Date(item.timerStartedAt).getTime());
}

/**
 * Case verdict of a manual execution: the worst step verdict (fail > blocked > pass); `skipped` when every
 * step is N/A.
 */
export function worstManualVerdict(verdicts: ManualStepVerdict[]): Verdict {
  if (verdicts.includes('fail')) return 'failed';
  if (verdicts.includes('blocked')) return 'blocked';
  if (verdicts.includes('pass')) return 'passed';
  return 'skipped';
}

/** Step result status for a manual step verdict. */
export function manualStepStatus(v: ManualStepVerdict): StepResult['status'] {
  return v === 'pass' ? 'passed' : v === 'fail' ? 'failed' : v === 'blocked' ? 'blocked' : 'skipped';
}
