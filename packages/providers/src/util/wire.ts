import { z } from 'zod';

/** One model answer on the wire; every field optional, unknown fields ignored. */
export const AnswerWireSchema = z.object({
  choice: z.string().optional(),
  score: z.number().optional(),
  noul: z.number().optional(),
  probabilities: z.record(z.number()).optional(),
});
export type AnswerWire = z.infer<typeof AnswerWireSchema>;
