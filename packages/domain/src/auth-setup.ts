import { z } from 'zod';

import { IdSchema, IsoTimestampSchema } from './common.js';

export const AuthKindSchema = z.enum(['recorded', 'flow']);
export type AuthKind = z.infer<typeof AuthKindSchema>;

export const AuthStatusSchema = z.enum(['valid', 'expired', 'never']);
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

/** Check run on a page opened with the saved state; failing it marks the state `expired`. */
export const AuthAssertionSchema = z.object({
  kind: z.enum(['text-visible', 'text-absent', 'url-contains']),
  value: z.string().min(1),
});
export type AuthAssertion = z.infer<typeof AuthAssertionSchema>;

export const AuthValidationSchema = z.object({
  /** Absolute URL, or a path resolved against the environment's base URL. */
  url: z.string().min(1),
  assertion: AuthAssertionSchema,
});
export type AuthValidation = z.infer<typeof AuthValidationSchema>;

/** Name usable in a case precondition `auth: <name>`. */
export const AuthNameSchema = z.string().regex(/^[\w][\w .-]*$/, 'use letters, digits, space, dot, dash or underscore');

/**
 * A saved login for an environment. The storage state itself is never part of this object: it lives
 * encrypted in the database and is only handed to the runner (`hasState` says whether one exists).
 */
export const AuthSetupSchema = z.object({
  id: IdSchema,
  environmentId: IdSchema,
  name: AuthNameSchema,
  kind: AuthKindSchema,
  /** Shared step (id or name) executed at refresh time; `kind: 'flow'` only. */
  flowId: z.string().min(1).optional(),
  hasState: z.boolean().default(false),
  lastRefreshedAt: IsoTimestampSchema.optional(),
  status: AuthStatusSchema.default('never'),
  /** Optional: without it a stored state is considered valid until a run proves otherwise. */
  validation: AuthValidationSchema.optional(),
});
export type AuthSetup = z.infer<typeof AuthSetupSchema>;
