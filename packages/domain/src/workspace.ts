import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';

export const WorkspaceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  createdAt: IsoTimestampSchema.optional(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** Nestable folder of test cases. */
export const SuiteSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  parentId: IdSchema.optional(),
  name: z.string().min(1),
  position: z.number().int().min(0).default(0),
});
export type Suite = z.infer<typeof SuiteSchema>;

/** Data table (CSV/JSON rows), optionally scoped to one environment. */
export const TestDataSetSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  environmentId: IdSchema.optional(),
  name: z.string().min(1),
  rows: z.array(z.record(z.union([z.string(), z.number(), z.boolean()]))).default([]),
});
export type TestDataSet = z.infer<typeof TestDataSetSchema>;
