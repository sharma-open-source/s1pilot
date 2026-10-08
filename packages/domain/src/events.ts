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
  z.object({
    type: z.literal('observation.elements'),
    ...stepRef,
    /** Interactive elements of the page as observed (viewport-relative CSS pixel boxes) for the element box overlay. */
    elements: z.array(
      z.object({
        id: z.string(),
        role: z.string(),
        label: z.string(),
        box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      }),
    ),
    /** Id of the element System 1 picked for the next action, when it picked one. */
    chosenId: z.string().optional(),
  }),
  z.object({ type: z.literal('assertion.verdict'), ...stepRef, verdict: AssertionVerdictSchema }),
  z.object({
    type: z.literal('escalation.needed'),
    ...stepRef,
    escalationId: IdSchema,
    reason: z.enum(['low-confidence', 'stuck', 'blocked', 'sensitive-action']),
    to: EscalationTargetSchema,
    options: z.array(z.string()).default([]),
    /** The question being decided (S-037). */
    question: z.string().optional(),
    /** Why the human is asked, in words (the gate's explanation). */
    detail: z.string().optional(),
    /** Option id to model probability. */
    probabilities: z.record(z.string(), z.number()).optional(),
    /** Option id to description, for display. */
    optionLabels: z.record(z.string(), z.string()).optional(),
    /** What System 2 picked, when it was consulted. */
    s2Choice: z.string().optional(),
    /** Gate thresholds in force. */
    thresholds: z.record(z.string(), z.number()).optional(),
  }),
  z.object({
    type: z.literal('escalation.resolved'),
    ...base,
    escalationId: IdSchema,
    resolution: z.enum(['approved', 'picked-other', 'taken-over', 'skipped', 'aborted', 'timed-out']),
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

/**
 * Control messages a client sends on the run WebSocket (or as the `runs.control` tRPC mutation), S-037.
 * `approve` confirms the model's pick, `pickOther` chooses another option; both answer an `escalation.needed`.
 */
export const RunControlMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve'), escalationId: IdSchema, choice: z.string().min(1), saveToLearned: z.boolean().default(true) }),
  z.object({ type: z.literal('pickOther'), escalationId: IdSchema, choice: z.string().min(1) }),
  z.object({ type: z.literal('skipStep') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('resume') }),
  z.object({ type: z.literal('abort') }),
  z.object({ type: z.literal('takeover') }),
  z.object({ type: z.literal('release') }),
]);
export type RunControlMessage = z.infer<typeof RunControlMessageSchema>;
