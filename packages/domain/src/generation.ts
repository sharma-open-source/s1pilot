import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';
import { PrioritySchema, StepSchema, TestCaseTypeSchema } from './test-case.js';

/** Tag that marks a case drafted by System 2 (`generatedBy: 's2'`). */
export const S2_GENERATED_TAG = 's2-generated';

/** One test case as System 2 proposes it (the key is allocated by the server, the status is always `draft`). */
export const GeneratedCaseSchema = z.object({
  title: z.string().trim().min(1),
  priority: PrioritySchema.default('P2'),
  type: TestCaseTypeSchema.default('e2e'),
  tags: z.array(z.string().trim().min(1)).default([]),
  steps: z
    .array(StepSchema.pick({ action: true, expected: true }))
    .min(1, 'a test case needs at least one step'),
});
export type GeneratedCase = z.infer<typeof GeneratedCaseSchema>;

/** System 2 JSON-mode reply: `{ "cases": [...] }` (a bare array is accepted too). */
export const GeneratedCasesSchema = z.preprocess(
  (v) => (Array.isArray(v) ? { cases: v } : v),
  z.object({ cases: z.array(GeneratedCaseSchema).min(1, 'no test cases were generated') }),
);
export type GeneratedCases = z.infer<typeof GeneratedCasesSchema>;

export const DraftSourceSchema = z.enum(['story', 'crawl']);
export type DraftSource = z.infer<typeof DraftSourceSchema>;

/** What happened to a generated draft. `accepted-as-is` / `accepted-edited` / `discarded` feed the P5 exit metric. */
export const DraftOutcomeSchema = z.enum(['accepted-as-is', 'accepted-edited', 'discarded']);
export type DraftOutcome = z.infer<typeof DraftOutcomeSchema>;

/** Provenance and fate of one generated draft (kept in settings; the case itself stays a normal case). */
export const DraftRecordSchema = z.object({
  caseId: IdSchema,
  caseKey: z.string().min(1),
  title: z.string(),
  source: DraftSourceSchema,
  /** Requirement the story came from, if any. */
  requirementKey: z.string().optional(),
  /** Page the test was suggested for (crawl). */
  pageUrl: z.string().optional(),
  /** Case version when it was generated; a higher version at decision time means it was edited. */
  createdVersion: z.number().int().min(1),
  createdAt: IsoTimestampSchema,
  outcome: DraftOutcomeSchema.optional(),
  resolvedAt: IsoTimestampSchema.optional(),
});
export type DraftRecord = z.infer<typeof DraftRecordSchema>;

/** Acceptance metrics of generated drafts (exit criterion of phase P5: accepted >= 50% with minor edits). */
export interface DraftMetrics {
  generated: number;
  pending: number;
  acceptedAsIs: number;
  acceptedEdited: number;
  discarded: number;
  /** (acceptedAsIs + acceptedEdited) / generated, or null when nothing was generated. */
  acceptanceRate: number | null;
}
