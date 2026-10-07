import { z } from 'zod';

import { CapabilitiesSchema } from './decision.js';
import { AdapterKindSchema, ThresholdsSchema } from './model-settings.js';

/** Capability profile of a known System 1 model (`profiles/*.json`). */
export const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'profile id must be lowercase letters, digits and dashes'),
  name: z.string().min(1),
  description: z.string().optional(),
  capabilities: CapabilitiesSchema,
  /** Starting thresholds; tune per project from review outcomes (calibration, S-058). */
  thresholds: ThresholdsSchema,
  recommendedAdapter: AdapterKindSchema,
  /** Tokenizer map label → token id, for `allowed_token_ids` with the `openai-logprobs` adapter. */
  tokenIds: z.record(z.number().int().min(0)).optional(),
  notes: z.string().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;
