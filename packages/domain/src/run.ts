import { z } from 'zod';

import { IdSchema, IsoTimestampSchema, ProbabilitiesSchema, ProbabilitySchema } from './common.js';
import { BrowserNameSchema } from './environment.js';

export const VerdictSchema = z.enum([
  'passed',
  'failed',
  'blocked',
  'skipped',
  'flaky',
  'needs-review',
]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const CaseModeSchema = z.enum(['replay', 'healed', 'explore', 'manual']);
export type CaseMode = z.infer<typeof CaseModeSchema>;

export const EscalationTargetSchema = z.enum(['system2', 'human']);
export type EscalationTarget = z.infer<typeof EscalationTargetSchema>;

export const DecisionRecordSchema = z.object({
  questionId: z.string().min(1),
  options: z.array(z.string()),
  probabilities: ProbabilitiesSchema,
  chosen: z.string().optional(),
  confidence: ProbabilitySchema,
  model: z.string().min(1),
  latencyMs: z.number().min(0),
  escalatedTo: EscalationTargetSchema.optional(),
  /** User id of the human who made the decision (human escalations only, S-037). */
  decidedBy: z.string().min(1).optional(),
  /** Channel the human decided through: the live run view, the CLI prompt or the API. */
  via: z.enum(['live', 'cli', 'api']).optional(),
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

export const EvidenceSchema = z.object({
  kind: z.enum(['screenshot', 'video', 'trace', 'log', 'console', 'network', 'dom', 'a11y']),
  artifactId: IdSchema,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const AssertionVerdictSchema = z.object({
  /** Assertion type (`urlMatches`, `ai`, …) or `expected` for the step's expected text. */
  assertion: z.string().min(1),
  verdict: z.enum(['pass', 'fail', 'needs-review']),
  /** P(true) for AI-judged assertions. */
  probability: ProbabilitySchema.optional(),
  message: z.string().optional(),
});
export type AssertionVerdict = z.infer<typeof AssertionVerdictSchema>;

export const StepResultSchema = z.object({
  id: IdSchema,
  caseResultId: IdSchema,
  stepIndex: z.number().int().min(0),
  status: z.enum(['passed', 'failed', 'blocked', 'skipped']),
  /** How the step was performed: learned script (`replay`), re-resolved (`healed`) or AI-driven (`explore`). */
  mode: z.enum(['replay', 'healed', 'explore']).optional(),
  /** Description of the action actually taken. */
  actionTaken: z.string().optional(),
  decisions: z.array(DecisionRecordSchema).default([]),
  assertions: z.array(AssertionVerdictSchema).default([]),
  evidence: z.array(EvidenceSchema).default([]),
  latencyMs: z.number().min(0).default(0),
});
export type StepResult = z.infer<typeof StepResultSchema>;

export const CaseResultSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  caseId: IdSchema,
  caseVersion: z.number().int().min(1),
  environmentId: IdSchema.optional(),
  browser: BrowserNameSchema.optional(),
  attempt: z.number().int().min(1).default(1),
  verdict: VerdictSchema,
  confidence: ProbabilitySchema.optional(),
  durationMs: z.number().min(0),
  mode: CaseModeSchema,
  escalations: z.number().int().min(0).default(0),
  /** Why the case did not run, e.g. `quarantined` for a `skipped` result (S-051). */
  reason: z.string().optional(),
});
export type CaseResult = z.infer<typeof CaseResultSchema>;

export const RunTriggerSchema = z.enum(['manual', 'schedule', 'ci', 'webhook', 'retest']);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

/**
 * Run lifecycle. `finished` / `aborted` are the legacy terminal values; server-executed runs (S-034) end in
 * `passed`, `failed`, `needs-review`, `cancelled` or `error`.
 */
export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'finished',
  'aborted',
  'passed',
  'failed',
  'needs-review',
  'cancelled',
  'error',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSummarySchema = z.object({
  passed: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  blocked: z.number().int().min(0).default(0),
  skipped: z.number().int().min(0).default(0),
  flaky: z.number().int().min(0).default(0),
  needsReview: z.number().int().min(0).default(0),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const TestRunSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  planId: IdSchema.optional(),
  trigger: RunTriggerSchema,
  /** Commit SHA or build number. */
  buildRef: z.string().optional(),
  status: RunStatusSchema,
  startedAt: IsoTimestampSchema.optional(),
  finishedAt: IsoTimestampSchema.optional(),
  summary: RunSummarySchema.default({}),
});
export type TestRun = z.infer<typeof TestRunSchema>;
