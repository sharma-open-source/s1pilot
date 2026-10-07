import { z } from 'zod';

import { IdSchema } from './common.js';
import { StepSchema } from './test-case.js';

export const SharedStepSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  name: z.string().min(1),
  /** Parameter names substituted as `{name}` in the steps. */
  params: z.array(z.string()).default([]),
  steps: z.array(StepSchema).min(1),
});
export type SharedStep = z.infer<typeof SharedStepSchema>;
