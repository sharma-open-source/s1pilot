import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';

export const DefectSeveritySchema = z.enum(['S1', 'S2', 'S3', 'S4']);
export type DefectSeverity = z.infer<typeof DefectSeveritySchema>;

export const DefectStatusSchema = z.enum(['open', 'in-progress', 'resolved', 'closed']);
export type DefectStatus = z.infer<typeof DefectStatusSchema>;

export const ExternalTrackerRefSchema = z.object({
  provider: z.enum(['jira', 'github', 'linear']),
  id: z.string().min(1),
  url: z.string().url().optional(),
});
export type ExternalTrackerRef = z.infer<typeof ExternalTrackerRefSchema>;

export const DefectSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  severity: DefectSeveritySchema,
  status: DefectStatusSchema.default('open'),
  /** CaseResult ids this defect was raised from. */
  linkedResultIds: z.array(IdSchema).default([]),
  external: ExternalTrackerRefSchema.optional(),
  createdAt: IsoTimestampSchema.optional(),
  updatedAt: IsoTimestampSchema.optional(),
});
export type Defect = z.infer<typeof DefectSchema>;
