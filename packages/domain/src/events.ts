import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';
import {
  AssertionVerdictSchema,
  DecisionRecordSchema,
  EscalationTargetSchema,
  RunStatusSchema,
  RunSummarySchema,
  VerdictSchema,
} from './run.js';

const base = { runId: IdSchema, ts: IsoTimestampSchema };
const stepRef = { ...base, caseResultId: IdSchema, stepIndex: z.number().int().min(0) };

/** Events pushed over the run WebSocket (S-036). Discriminated on `type`. */
export const RunEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run.started'),
    ...base,
    planId: IdSchema.optional(),
    totalCases: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('case.started'),
    ...base,
    caseResultId: IdSchema,
    caseId: IdSchema,
    caseKey: z.string().optional(),
  }),
  z.object({ type: z.literal('step.started'), ...stepRef, action: z.string() }),
  z.object({ type: z.literal('decision.made'), ...stepRef, decision: DecisionRecordSchema }),
  z.object({ type: z.literal('assertion.verdict'), ...stepRef, verdict: AssertionVerdictSchema }),
  z.object({
    type: z.literal('escalation.needed'),
    ...stepRef,
    escalationId: IdSchema,
    reason: z.enum(['low-confidence', 'stuck', 'blocked', 'sensitive-action']),
    to: EscalationTargetSchema,
    options: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal('escalation.resolved'),
    ...base,
    escalationId: IdSchema,
    resolution: z.enum(['approved', 'picked-other', 'taken-over', 'skipped', 'aborted']),
    by: EscalationTargetSchema,
    chosen: z.string().optional(),
  }),
  z.object({
    type: z.literal('step.finished'),
    ...stepRef,
    status: z.enum(['passed', 'failed', 'blocked', 'skipped']),
    durationMs: z.number().min(0),
  }),
  z.object({
    type: z.literal('case.finished'),
    ...base,
    caseResultId: IdSchema,
    verdict: VerdictSchema,
    durationMs: z.number().min(0),
  }),
  z.object({
    type: z.literal('run.finished'),
    ...base,
    status: RunStatusSchema,
    summary: RunSummarySchema,
  }),
  z.object({
    type: z.literal('log'),
    ...base,
    level: z.enum(['debug', 'info', 'warn', 'error']),
    message: z.string(),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
