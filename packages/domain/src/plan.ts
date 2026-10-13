import { z } from 'zod';

import { A11yImpactSchema } from './checks.js';
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
  /** Accessibility impact (axe) at or above which the case fails; lower impacts warn. Default `serious` (S-053). */
  a11yFailImpact: A11yImpactSchema.optional(),
  /** axe rule ids not to run. */
  a11yDisabledRules: z.array(z.string()).optional(),
  /** Regexes: console messages / failing request URLs matching one are ignored. */
  consoleAllow: z.array(z.string()).optional(),
  networkAllow: z.array(z.string()).optional(),
  /** Also flag failing requests to other origins than the environment's. Default false. */
  networkThirdParty: z.boolean().optional(),
});
export type PlanChecks = z.infer<typeof PlanChecksSchema>;

/** Label of a worker (`gpu`, `eu`); plans can require labels so their jobs only run on matching workers (S-068). */
export const WorkerLabelSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, 'labels are letters, digits, dot, dash or underscore');
export type WorkerLabel = z.infer<typeof WorkerLabelSchema>;

export const TestPlanSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  name: z.string().min(1),
  release: z.string().optional(),
  selection: PlanSelectionSchema,
  matrix: z.array(MatrixEntrySchema).min(1, 'a plan needs at least one matrix entry'),
  retries: z.number().int().min(0).max(5).default(0),
  parallelism: z.number().int().min(1).default(1),
  /** Run only on workers carrying all of these labels; empty = any worker (S-068). */
  workerLabels: z.array(WorkerLabelSchema).default([]),
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
