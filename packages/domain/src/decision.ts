import { z } from 'zod';

import { ProbabilitiesSchema, ProbabilitySchema } from './common.js';

export const QuestionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), instructions: z.string().min(1) }),
  z.object({
    type: z.literal('choice'),
    instructions: z.string().min(1),
    /** Option id → description. */
    criteria: z.record(z.string()),
  }),
  z.object({
    type: z.literal('score'),
    instructions: z.string().min(1),
    criteria: z.array(z.string()),
  }),
]);
export type Question = z.infer<typeof QuestionSchema>;

export const CapabilitiesSchema = z.object({
  maxOptions: z.number().int().min(1),
  multiQuestionPerCall: z.boolean(),
  supportsImages: z.boolean(),
  maxContextTokens: z.number().int().min(1),
  orderSensitive: z.boolean(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const ImagePartSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  /** Base64-encoded bytes. */
  data: z.string().min(1),
});
export type ImagePart = z.infer<typeof ImagePartSchema>;

export const DecideRequestSchema = z.object({
  /** Observation passed to the model; treated as untrusted data. */
  state: z.unknown(),
  images: z.array(ImagePartSchema).optional(),
  questions: z.record(QuestionSchema),
});
export type DecideRequest = z.infer<typeof DecideRequestSchema>;

export const DecideAnswerSchema = z.object({
  choice: z.string().optional(),
  score: z.number().optional(),
  /** P(true) for `noul` questions. */
  noul: ProbabilitySchema.optional(),
  probabilities: ProbabilitiesSchema,
  confidence: ProbabilitySchema,
  /** Model output before calibration (S-058); present only when a calibrator changed the probabilities. */
  raw: z.object({ probabilities: ProbabilitiesSchema, confidence: ProbabilitySchema }).optional(),
});
export type DecideAnswer = z.infer<typeof DecideAnswerSchema>;

/** Contract every System 1 adapter implements (plan §5). Implementations: S-006+. */
export interface DecisionModel {
  capabilities: Capabilities;
  /** Answers each question in `req.questions`, keyed by the same ids. */
  decide(req: DecideRequest): Promise<Record<string, DecideAnswer>>;
}
