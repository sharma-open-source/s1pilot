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

/** Entry in the review queue: a `needs-review` verdict or a heal proposal. Minimal shape; S-047 may extend. */
export const ReviewItemSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  kind: z.enum(['verdict', 'heal']),
  /** CaseResult id or HealProposal id, depending on `kind`. */
  refId: IdSchema,
  status: ReviewStatusSchema.default('pending'),
  note: z.string().optional(),
  createdAt: IsoTimestampSchema.optional(),
  resolvedAt: IsoTimestampSchema.optional(),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
