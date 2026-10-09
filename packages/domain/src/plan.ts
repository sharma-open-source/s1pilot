import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';
import { BrowserNameSchema } from './environment.js';
import { PlanAssignmentSchema } from './manual.js';

export const PlanSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list'), caseIds: z.array(IdSchema) }),
  /** Saved query, e.g. `tags:smoke AND priority<=P1` (grammar: S-049). */
  z.object({ kind: z.literal('query'), query: z.string().min(1) }),
]);
export type PlanSelection = z.infer<typeof PlanSelectionSchema>;

export const MatrixEntrySchema = z.object({
  environmentId: IdSchema,
  browser: BrowserNameSchema,
  device: z.string().optional(),
});
export type MatrixEntry = z.infer<typeof MatrixEntrySchema>;

export const ExecutionModeSchema = z.enum(['replay-heal', 'explore', 'replay-only']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/** Stored exit criterion; typed forms and evaluation live in `exit-criteria.ts`. */
export const ExitCriterionSchema = z.object({
  kind: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});
export type ExitCriterion = z.infer<typeof ExitCriterionSchema>;

export const PlanChecksSchema = z.object({
  a11y: z.boolean().default(false),
  consoleErrors: z.boolean().default(false),
  visual: z.boolean().default(false),
  video: z.boolean().default(false),
});
export type PlanChecks = z.infer<typeof PlanChecksSchema>;

export const TestPlanSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  name: z.string().min(1),
  release: z.string().optional(),
  selection: PlanSelectionSchema,
  matrix: z.array(MatrixEntrySchema).min(1, 'a plan needs at least one matrix entry'),
  retries: z.number().int().min(0).max(5).default(0),
  parallelism: z.number().int().min(1).default(1),
  mode: ExecutionModeSchema.default('replay-heal'),
  /** What to do when a run needs a human but nobody is watching. */
  unattended: z.enum(['block', 'pause']).default('block'),
  /** Cron expression. */
  schedule: z.string().optional(),
  exitCriteria: z.array(ExitCriterionSchema).default([]),
  checks: PlanChecksSchema.default({}),
  /** Per-case assignee / manual flag, keyed by case id (S-055). */
  assignments: z.record(PlanAssignmentSchema).default({}),
  createdAt: IsoTimestampSchema.optional(),
  updatedAt: IsoTimestampSchema.optional(),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;
