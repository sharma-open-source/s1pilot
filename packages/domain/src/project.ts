import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';
import { PROJECT_KEY_REGEX } from './ids.js';
import { DataPolicySchema, ModelSettingsSchema } from './model-settings.js';

export const ProjectKeySchema = z
  .string()
  .regex(
    PROJECT_KEY_REGEX,
    'Project key must be 2–10 characters: uppercase letters or digits, starting with a letter (e.g. SHOP)',
  );

export const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  key: ProjectKeySchema,
  defaultEnvironmentId: IdSchema.optional(),
  /** Project override; absent means inherit the workspace default. */
  modelSettings: ModelSettingsSchema.optional(),
  retentionDays: z.number().int().positive().default(30),
  dataPolicy: DataPolicySchema.default({}),
  createdAt: IsoTimestampSchema.optional(),
  updatedAt: IsoTimestampSchema.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;
