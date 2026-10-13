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

const SECRET_KEY_RE =
  /password|passwd|passcode|passphrase|pwd|secret|token|credential|api[\s_-]?key|private[\s_-]?key|(^|[^a-z])(pass|pin|otp|cvv|cvc)([^a-z]|$)/i;

/**
 * True when a variable key names something that should be a secret (`PASSWORD`, `admin_pwd`, `apiKey`, `auth_token`).
 * Such keys must not be stored as plain variables: their values would be shown in clear text and sent to models.
 */
export function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** Keys of plain (non-secret) variables whose names look like secrets; see {@link looksLikeSecretKey}. */
export function plainSecretLikeKeys(variables: readonly Pick<Variable, 'key' | 'secret'>[]): string[] {
  return variables.filter((v) => !v.secret && looksLikeSecretKey(v.key)).map((v) => v.key);
}

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
