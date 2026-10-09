import { IdSchema, S1PilotError } from '@s1pilot/domain';
import { z } from 'zod';

import { TokenScopeSchema, ciUsage, createApiToken, listApiTokens, revokeApiToken } from '../../auth/tokens.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

/** Token management needs the local session (or, later, an admin); API tokens cannot manage tokens. */
export function requireSession(ctx: Context): void {
  if (ctx.token) throw new S1PilotError('FORBIDDEN', 'API tokens cannot change workspace settings');
  if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot change workspace settings');
}

/**
 * API tokens for CLI / CI (S-059). The plaintext token is returned once by `create`; afterwards only the
 * visible prefix is available. Tokens are stored as salted scrypt hashes.
 */
export const tokensRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    requireSession(ctx);
    return listApiTokens(ctx.db);
  }),

  /** Last CI use per provider (github / gitlab / other) by an API token; drives the Integrations cards. */
  ciUsage: publicProcedure.query(({ ctx }) => {
    requireSession(ctx);
    return ciUsage(ctx.db);
  }),

  /** Returns `{ token, record }`; `token` is shown once and never retrievable again. */
  create: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(80),
        scopes: z.array(TokenScopeSchema).min(1).default(['runs:write', 'results:read']),
      }),
    )
    .mutation(({ ctx, input }) => {
      requireSession(ctx);
      return createApiToken(ctx.db, { name: input.name, scopes: input.scopes, createdBy: ctx.user.id });
    }),

  /** Revoked tokens answer 401 immediately. */
  revoke: publicProcedure.input(z.object({ id: IdSchema })).mutation(async ({ ctx, input }) => {
    requireSession(ctx);
    await revokeApiToken(ctx.db, input.id);
    return { ok: true as const };
  }),
});
