import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';

export const PrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export type Priority = z.infer<typeof PrioritySchema>;

export const TestCaseTypeSchema = z.enum(['smoke', 'regression', 'e2e', 'exploratory']);
export type TestCaseType = z.infer<typeof TestCaseTypeSchema>;

export const TestCaseStatusSchema = z.enum(['draft', 'ready', 'deprecated']);
export type TestCaseStatus = z.infer<typeof TestCaseStatusSchema>;

/** How an assertion finds its element; at least one field should be set. */
const targetShape = {
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  testId: z.string().optional(),
  css: z.string().optional(),
};

export const AssertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('urlMatches'), pattern: z.string().min(1) }),
  z.object({ type: z.literal('titleContains'), contains: z.string().min(1) }),
  z.object({ type: z.literal('elementVisible'), ...targetShape, visible: z.boolean().default(true) }),
  z.object({
    type: z.literal('elementText'),
    ...targetShape,
    contains: z.string().optional(),
    equals: z.string().optional(),
  }),
  z.object({ type: z.literal('elementValue'), ...targetShape, equals: z.string() }),
  z.object({
    type: z.literal('elementCount'),
    ...targetShape,
    equals: z.number().int().min(0).optional(),
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
  }),
  z.object({
    type: z.literal('responseStatus'),
    urlPattern: z.string().min(1),
    status: z.number().int().min(100).max(599),
    method: z.string().optional(),
  }),
  z.object({ type: z.literal('noConsoleErrors'), allow: z.array(z.string()).default([]) }),
  z.object({ type: z.literal('downloadExists'), filenamePattern: z.string().optional() }),
  z.object({
    type: z.literal('apiCheck'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    url: z.string().min(1),
    status: z.number().int().min(100).max(599).optional(),
    bodyContains: z.string().optional(),
  }),
  z.object({
    type: z.literal('ai'),
    /** Plain-language expectation judged by the System 1 model. */
    expected: z.string().min(1),
    /** Critical assertions are judged in dual order. */
    critical: z.boolean().default(false),
  }),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

export const StepSchema = z.object({
  action: z.string().min(1, 'step action must not be empty'),
  expected: z.string().optional(),
  assert: z.array(AssertionSchema).default([]),
  /** Test-data keys the step may use for text input. */
  inputs: z.array(z.string()).default([]),
  sharedStepId: IdSchema.optional(),
  /** Arguments bound to `{name}` placeholders of the shared step (YAML `flow:` steps). */
  args: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export type Step = z.infer<typeof StepSchema>;

/** Data-driven rows; each row binds `{name}` placeholders in step text. */
export const ParametersSchema = z.array(
  z.record(z.union([z.string(), z.number(), z.boolean()])),
);
export type Parameters = z.infer<typeof ParametersSchema>;

export const PreconditionSchema = z.union([
  z.object({ flow: z.string().min(1) }).strict(),
  z.object({ auth: z.string().min(1) }).strict(),
]);
export type Precondition = z.infer<typeof PreconditionSchema>;

const caseFields = {
  key: z.string().min(1),
  title: z.string().min(1),
  priority: PrioritySchema,
  type: TestCaseTypeSchema,
  status: TestCaseStatusSchema,
  tags: z.array(z.string()).default([]),
  requirements: z.array(z.string()).default([]),
  preconditions: z.array(PreconditionSchema).default([]),
  parameters: ParametersSchema.default([]),
  steps: z.array(StepSchema).min(1, 'a test case needs at least one step'),
  owner: z.string().optional(),
};

/** Persisted test case. */
export const TestCaseSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  suiteId: IdSchema.optional(),
  version: z.number().int().min(1).default(1),
  ...caseFields,
  /** Quarantined cases are excluded from plan runs by default (S-051). Absent means not quarantined. */
  quarantined: z.boolean().optional(),
  quarantineReason: z.string().optional(),
  quarantinedAt: IsoTimestampSchema.optional(),
  /** Flakiness score 0..1 over the last executions (S-051). Absent means not computed yet. */
  flakiness: z.number().min(0).max(1).optional(),
  createdAt: IsoTimestampSchema.optional(),
  updatedAt: IsoTimestampSchema.optional(),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

/** YAML-facing shape (`.s1pilot/suites/**\/*.yaml`); mirrors plan §1.2. */
export const TestCaseFileSchema = z.object({
  ...caseFields,
  priority: PrioritySchema.default('P2'),
  type: TestCaseTypeSchema.default('e2e'),
  status: TestCaseStatusSchema.default('draft'),
});
export type TestCaseFile = z.infer<typeof TestCaseFileSchema>;
