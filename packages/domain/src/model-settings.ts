import { z } from 'zod';

import { ProbabilitySchema } from './common.js';

export const AdapterKindSchema = z.enum(['systemone', 'decide', 'openai-logprobs', 'openai-chat', 'mock']);
export type AdapterKind = z.infer<typeof AdapterKindSchema>;

export const ModelEndpointSchema = z
  .object({
    adapter: AdapterKindSchema,
    baseUrl: z.string().url('baseUrl must be a valid URL').optional(),
    model: z.string().min(1),
    /** Reference to a secret (`secret:<key>`), never the key itself. */
    apiKeyRef: z.string().optional(),
    profileId: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.adapter !== 'mock' && value.baseUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['baseUrl'],
        message: `baseUrl is required for the "${value.adapter}" adapter`,
      });
    }
  });
export type ModelEndpoint = z.infer<typeof ModelEndpointSchema>;

export const ThresholdsSchema = z
  .object({
    /** Confidence at or above which the engine acts automatically. */
    act: ProbabilitySchema,
    /** P(true) at or above which an assertion passes. */
    pass: ProbabilitySchema,
    /** P(true) at or below which an assertion fails. */
    fail: ProbabilitySchema,
    /** Confidence below which the decision escalates to a human. */
    escalate: ProbabilitySchema,
  })
  .refine((t) => t.fail <= t.pass, {
    path: ['fail'],
    message: 'fail threshold must not exceed pass threshold',
  })
  .refine((t) => t.escalate <= t.act, {
    path: ['escalate'],
    message: 'escalate threshold must not exceed act threshold',
  });
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const ModelSettingsSchema = z.object({
  system1: ModelEndpointSchema,
  system2: ModelEndpointSchema.optional(),
  thresholds: ThresholdsSchema,
  dualOrderSensitive: z.boolean().default(false),
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export const ScreenshotPolicySchema = z.enum(['never', 'ambiguous', 'always']);

export const DataPolicySchema = z.object({
  sendPageText: z.boolean().default(true),
  sendScreenshots: ScreenshotPolicySchema.default('ambiguous'),
  redactPatterns: z.array(z.string()).default([]),
});
export type DataPolicy = z.infer<typeof DataPolicySchema>;
