import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';

export const DefectSeveritySchema = z.enum(['S1', 'S2', 'S3', 'S4']);
export type DefectSeverity = z.infer<typeof DefectSeveritySchema>;

export const DefectStatusSchema = z.enum(['draft', 'open', 'in-progress', 'fixed', 'closed']);
export type DefectStatus = z.infer<typeof DefectStatusSchema>;

export const ExternalTrackerRefSchema = z.object({
  provider: z.enum(['jira', 'github', 'linear']),
  id: z.string().min(1),
  url: z.string().url().optional(),
});
export type ExternalTrackerRef = z.infer<typeof ExternalTrackerRefSchema>;

/** Where a defect was raised from. */
export const DefectSourceKindSchema = z.enum(['result', 'manual', 'a11y']);
export type DefectSourceKind = z.infer<typeof DefectSourceKindSchema>;

/** Evidence attached to a defect: a stored artifact of the failing result (screenshot, trace, video, ...). */
export const DefectEvidenceSchema = z.object({
  artifactId: IdSchema,
  kind: z.string().min(1),
  label: z.string().optional(),
});
export type DefectEvidence = z.infer<typeof DefectEvidenceSchema>;

/** Structured body of a defect (steps, expected vs actual, context). Stored as JSON. */
export const DefectDetailsSchema = z.object({
  stepsToReproduce: z.array(z.string()).default([]),
  expected: z.string().default(''),
  actual: z.string().default(''),
  environment: z.string().optional(),
  browser: z.string().optional(),
  buildRef: z.string().optional(),
  evidence: z.array(DefectEvidenceSchema).default([]),
  sourceKind: DefectSourceKindSchema.default('result'),
  /** Human label of the origin, e.g. `SHOP-TC-44` or `accessibility scan`. */
  sourceLabel: z.string().optional(),
  /** 0-based failing step of the source result. */
  stepIndex: z.number().int().min(0).optional(),
  /** Queue linked failed case instances as a re-test run when the defect becomes fixed / closed. */
  retest: z.boolean().default(false),
  /** Run queued by the last automatic re-test. */
  retestRunId: IdSchema.optional(),
  /** Last tracker status category seen by the sync (S-064); a change of it drives local status updates. */
  trackerState: z.string().optional(),
});
export type DefectDetails = z.infer<typeof DefectDetailsSchema>;

export const DefectSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  title: z.string().min(1),
  /** Per-project sequence number; the human key is `DEF-<seq>`. */
  seq: z.number().int().min(1).optional(),
  description: z.string().optional(),
  details: DefectDetailsSchema.optional(),
  severity: DefectSeveritySchema,
  status: DefectStatusSchema.default('open'),
  /** CaseResult ids this defect was raised from. */
  linkedResultIds: z.array(IdSchema).default([]),
  external: ExternalTrackerRefSchema.optional(),
  createdAt: IsoTimestampSchema.optional(),
  updatedAt: IsoTimestampSchema.optional(),
});
export type Defect = z.infer<typeof DefectSchema>;

/** Human key of a defect (`DEF-12`); falls back to the id's first characters for rows without a sequence number. */
export function defectKey(d: Pick<Defect, 'id' | 'seq'>): string {
  return d.seq !== undefined ? `DEF-${d.seq}` : `DEF-${d.id.slice(0, 6)}`;
}
