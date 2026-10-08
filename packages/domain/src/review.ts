import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';
import { ResolvedActionSchema } from './learned-script.js';

export const ReviewStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

/**
 * A healed step proposed for review (plan section 2.3). `before` / `after` are the complete
 * action lists of the step; approving replaces `before` with `after` in the learned script(s).
 */
export const HealProposalSchema = z.object({
  id: IdSchema,
  caseId: IdSchema,
  stepIndex: z.number().int().min(0),
  environmentId: IdSchema,
  runId: IdSchema,
  before: z.array(ResolvedActionSchema),
  after: z.array(ResolvedActionSchema),
  /** Lowest System 1 confidence among the decisions that produced `after`. */
  confidence: z.number().min(0).max(1),
  /** Whether System 2 agreed with the heal, when it was consulted. */
  s2Agreed: z.boolean().optional(),
  /** User who approved the heal during a live (attended) run. */
  approvedLive: IdSchema.optional(),
  /** Shared step / flow the healed step belongs to. */
  sharedStepId: IdSchema.optional(),
  /** Every case that uses the shared step (including `caseId`). */
  impactCaseIds: z.array(IdSchema).default([]),
  status: ReviewStatusSchema.default('pending'),
  createdAt: IsoTimestampSchema.optional(),
});
export type HealProposal = z.infer<typeof HealProposalSchema>;

/**
 * What a human decided about an uncertain model verdict, stored for calibration (plan section 2.5, S-058).
 * `pTrue` is the model's P(true) for the assertion (null when the result carried none).
 */
export const ReviewOutcomeSchema = z.object({
  pTrue: z.number().min(0).max(1).nullable(),
  humanVerdict: z.enum(['passed', 'failed']),
  /** Kind of System 1 question that produced `pTrue` (`noul` for AI assertions). */
  questionType: z.enum(['noul', 'choice', 'score']),
  optionCount: z.number().int().min(1),
  /** Model that answered, when known. */
  model: z.string().nullable(),
  decidedBy: z.string().optional(),
});
export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

/** Entry in the review queue: a `needs-review` verdict or a heal proposal. Minimal shape; S-047 may extend. */
export const ReviewItemSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  kind: z.enum(['verdict', 'heal', 'decision']),
  /** CaseResult id, HealProposal id or escalation id (`decision`: a human decision recorded for calibration). */
  refId: IdSchema,
  status: ReviewStatusSchema.default('pending'),
  note: z.string().optional(),
  /** Calibration record of a decided `verdict` item. */
  outcome: ReviewOutcomeSchema.optional(),
  createdAt: IsoTimestampSchema.optional(),
  resolvedAt: IsoTimestampSchema.optional(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
