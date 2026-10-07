import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';

export const RequirementSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  /** Human key, e.g. `SHOP-REQ-7`. */
  key: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  /** Test cases covering this requirement. */
  caseIds: z.array(IdSchema).default([]),
  createdAt: IsoTimestampSchema.optional(),
  updatedAt: IsoTimestampSchema.optional(),
});
export type Requirement = z.infer<typeof RequirementSchema>;
