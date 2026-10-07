import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';
import { ResolvedActionSchema } from './learned-script.js';

export const ReviewStatusSchema = z.enum(['pending', 'approved', 'rejected']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

/** A healed step proposed for a learned script. Minimal shape; S-025 may extend. */
export const HealProposalSchema = z.object({
  id: IdSchema,
  learnedScriptId: IdSchema,
  runId: IdSchema,
  stepIndex: z.number().int().min(0),
  /** Replacement actions for the broken step. */
  actions: z.array(ResolvedActionSchema),
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
