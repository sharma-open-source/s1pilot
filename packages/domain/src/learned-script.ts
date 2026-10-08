import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';

export const LocatorCandidateSchema = z.object({
  kind: z.enum(['role', 'testId', 'text', 'css']),
  value: z.string().min(1),
  /** Accessible name, for `role` locators. */
  name: z.string().optional(),
});
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;

export const ActionKindSchema = z.enum([
  'click',
  'fill',
  'selectOption',
  'check',
  'uncheck',
  'press',
  'hover',
  'goto',
  'scroll',
  'goBack',
  'wait',
]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const ResolvedActionSchema = z.object({
  stepIndex: z.number().int().min(0),
  /** Position within the step when one step resolves to several actions. */
  subIndex: z.number().int().min(0),
  action: ActionKindSchema,
  locators: z.array(LocatorCandidateSchema).default([]),
  /** `secret:<key>` / `var:<key>` / `input:<key>`; never a literal secret. */
  valueRef: z.string().optional(),
  /** Hash of the page state this action was resolved against. */
  fingerprint: z.string().min(1),
  /** Hash of the page state after the action (S-023). */
  postFingerprint: z.string().min(1).optional(),
  /** What the replayer should wait for after the action (S-023). */
  waitHint: z.enum(['none', 'navigation']).optional(),
  /** Hash of the step text this action was learned for; a mismatch invalidates the action (S-023). */
  stepHash: z.string().min(1).optional(),
  fromRunId: IdSchema,
});
export type ResolvedAction = z.infer<typeof ResolvedActionSchema>;

export const LearnedScriptHealthSchema = z.object({
  healCount: z.number().int().min(0).default(0),
  lastHealedAt: IsoTimestampSchema.optional(),
  lastReplayedAt: IsoTimestampSchema.optional(),
  pendingProposals: z.number().int().min(0).default(0),
});
export type LearnedScriptHealth = z.infer<typeof LearnedScriptHealthSchema>;

export const LearnedScriptSchema = z.object({
  id: IdSchema,
  caseId: IdSchema,
  caseVersion: z.number().int().min(1),
  environmentId: IdSchema,
  actions: z.array(ResolvedActionSchema),
  createdFromRunId: IdSchema,
  createdAt: IsoTimestampSchema.optional(),
  health: LearnedScriptHealthSchema.default({}),
});
export type LearnedScript = z.infer<typeof LearnedScriptSchema>;
