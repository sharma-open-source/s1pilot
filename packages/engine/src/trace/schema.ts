import { DecisionRecordSchema, IdSchema, IsoTimestampSchema, LocatorCandidateSchema } from '@s1pilot/domain';
import { z } from 'zod';

const base = {
  /** Trace format version. */
  v: z.literal(1),
  ts: IsoTimestampSchema,
  runId: IdSchema,
  caseResultId: IdSchema,
  stepIndex: z.number().int().min(0),
};

/** Condensed observation: never element values, only counts and page-level text (redacted). */
export const ObservationSummarySchema = z.object({
  url: z.string(),
  title: z.string(),
  headings: z.array(z.string()),
  alerts: z.array(z.string()),
  dialogs: z.array(z.string()),
  elementCount: z.number().int().min(0),
  fingerprint: z.string(),
});
export type ObservationSummary = z.infer<typeof ObservationSummarySchema>;

/** Why a step ended. */
export const StepEndSchema = z.enum([
  'step_done',
  'blocked',
  'guard',
  'sensitive',
  'input',
  'stuck',
  'budget',
  'skipped',
  'aborted',
  'takeover',
  'error',
]);
export type StepEnd = z.infer<typeof StepEndSchema>;

export const StepStatusSchema = z.enum(['passed', 'failed', 'blocked', 'skipped']);

/**
 * One line of `trace.jsonl` (plan section 6): `step.started`, one `iteration` per observe/decide/act
 * cycle, and `step.finished`. Lines contain refs (`secret:key`) but never resolved values.
 */
export const TraceLineSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('step.started'),
    text: z.string(),
    inputs: z.array(z.string()),
  }),
  z.object({
    ...base,
    kind: z.literal('iteration'),
    iteration: z.number().int().min(1),
    observation: ObservationSummarySchema,
    /** Question id → option ids offered (ids only, no page text). */
    questions: z.record(z.object({ type: z.enum(['noul', 'choice', 'score']), options: z.array(z.string()) })),
    /** Region questions, `step_done`, `blocked` and `next_action` records, in order asked. */
    decisions: z.array(DecisionRecordSchema),
    gate: z.object({ outcome: z.string(), choice: z.string().optional(), reason: z.string() }).optional(),
    sensitive: z
      .object({ classification: z.string().nullable(), blocked: z.boolean(), rule: z.string().optional() })
      .optional(),
    action: z
      .object({
        kind: z.string(),
        elementId: z.string().optional(),
        target: z.string().optional(),
        valueRef: z.string().optional(),
      })
      .optional(),
    outcome: z
      .object({
        ok: z.boolean(),
        navigated: z.boolean(),
        durationMs: z.number().min(0),
        usedLocator: LocatorCandidateSchema.optional(),
        error: z.object({ code: z.string(), message: z.string() }).optional(),
      })
      .optional(),
    timingsMs: z.object({
      observe: z.number().min(0),
      narrow: z.number().min(0),
      decide: z.number().min(0),
      gate: z.number().min(0),
      execute: z.number().min(0),
    }),
  }),
  z.object({
    ...base,
    kind: z.literal('step.finished'),
    status: StepStatusSchema,
    ended: StepEndSchema,
    reason: z.string().optional(),
    actions: z.number().int().min(0),
    durationMs: z.number().min(0),
  }),
]);
export type TraceLine = z.infer<typeof TraceLineSchema>;
