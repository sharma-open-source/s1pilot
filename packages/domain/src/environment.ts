import { z } from 'zod';

import { IdSchema } from './common.js';

export const BrowserNameSchema = z.enum(['chromium', 'firefox', 'webkit']);
export type BrowserName = z.infer<typeof BrowserNameSchema>;

export const BrowserTargetSchema = z.object({
  browser: BrowserNameSchema,
  /** Playwright device descriptor name, e.g. `iPhone 13`. */
  device: z.string().optional(),
});
export type BrowserTarget = z.infer<typeof BrowserTargetSchema>;

export const SensitiveActionSchema = z.enum(['pay', 'delete', 'send']);
export type SensitiveAction = z.infer<typeof SensitiveActionSchema>;

export const VariableSchema = z
  .object({
    key: z.string().min(1),
    value: z.string().optional(),
    secret: z.boolean().default(false),
    source: z.enum(['inline', 'env']).default('inline'),
    envVar: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.source === 'env' && v.envVar === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['envVar'],
        message: 'envVar is required when source is "env"',
      });
    }
  });
export type Variable = z.infer<typeof VariableSchema>;

export const EnvironmentSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  name: z.string().min(1),
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  variables: z.array(VariableSchema).default([]),
  allowDomains: z.array(z.string()).default([]),
  authSetupFlowId: IdSchema.optional(),
  browsers: z.array(BrowserTargetSchema).min(1).default([{ browser: 'chromium' }]),
  readOnly: z.boolean().default(false),
  requireApprovalFor: z.array(SensitiveActionSchema).default(['pay', 'delete', 'send']),
  locale: z.string().default('en-US'),
  timezone: z.string().default('UTC'),
});
export type Environment = z.infer<typeof EnvironmentSchema>;
