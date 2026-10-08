import { z } from 'zod';

import { IsoTimestampSchema } from './common.js';
import { BrowserNameSchema } from './environment.js';
import { AssertionVerdictSchema, CaseModeSchema, DecisionRecordSchema, VerdictSchema } from './run.js';

/** One executed (or skipped) step of a case run, as written to reports. */
export const StepReportSchema = z.object({
  index: z.number().int().min(0),
  phase: z.literal('precondition').optional(),
  sharedStepId: z.string().optional(),
  action: z.string(),
  verdict: VerdictSchema,
  /** How the step was performed (the `StepResult.mode` value); absent for skipped steps. */
  mode: z.enum(['replay', 'healed', 'explore']).optional(),
  ended: z.string().optional(),
  reason: z.string().optional(),
  actionTaken: z.string().optional(),
  actions: z.number().int().min(0).default(0),
  iterations: z.number().int().min(0).default(0),
  durationMs: z.number().min(0).default(0),
  assertions: z.array(AssertionVerdictSchema).default([]),
  decisions: z.array(DecisionRecordSchema).default([]),
});
export type StepReport = z.infer<typeof StepReportSchema>;

/** Result of one case instance (one parameter row) in a run report. */
export const CaseRunResultSchema = z.object({
  runId: z.string(),
  caseResultId: z.string(),
  key: z.string(),
  title: z.string(),
  /** Suite the case belongs to (reporters group by it); `default` when none. */
  suite: z.string().default('default'),
  priority: z.string(),
  /** 1-based parameter row. */
  row: z.number().int().min(1).default(1),
  label: z.string().optional(),
  mode: CaseModeSchema,
  verdict: VerdictSchema,
  environment: z.string(),
  browser: BrowserNameSchema,
  params: z.record(z.string()).default({}),
  scriptKey: z.string(),
  /** Result directory name below the run's output directory. */
  dir: z.string(),
  startedAt: IsoTimestampSchema,
  durationMs: z.number().min(0),
  healProposals: z.number().int().min(0).default(0),
  steps: z.array(StepReportSchema),
});
export type CaseRunResult = z.infer<typeof CaseRunResultSchema>;

/** Full report of a run (what `runCases` returns); the JSON reporter writes exactly this. */
export const RunReportSchema = z.object({
  runId: z.string(),
  environment: z.string(),
  browser: BrowserNameSchema,
  /** Requested execution mode (`replay-heal`, `replay-only` or `explore`). */
  mode: z.enum(['replay-heal', 'explore', 'replay-only']),
  startedAt: IsoTimestampSchema,
  finishedAt: IsoTimestampSchema,
  durationMs: z.number().min(0),
  totals: z.object({
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    blocked: z.number().int().min(0),
    skipped: z.number().int().min(0),
    flaky: z.number().int().min(0),
    needsReview: z.number().int().min(0),
  }),
  steps: z.object({
    executed: z.number().int().min(0),
    passed: z.number().int().min(0),
    successRate: z.number().min(0).max(1),
  }),
  cases: z.array(CaseRunResultSchema),
});
export type RunReport = z.infer<typeof RunReportSchema>;
