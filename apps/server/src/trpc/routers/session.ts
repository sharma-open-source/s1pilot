import { repos } from '@s1pilot/db';
import { RoleSchema, S1PilotError, type Role } from '@s1pilot/domain';
import { z } from 'zod';

import { recordAudit } from '../../audit/audit.js';
import { acceptInvite, loginWithPassword, openInvite, setupFirstAdmin, toUser } from '../../auth/accounts.js';
import { EmailSchema, PasswordSchema } from '../../auth/credentials.js';
import { clearedSessionCookie, createSession, sessionCookie } from '../../auth/sessions.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

function requireTeamMode(ctx: Context): void {
  if (ctx.config.mode !== 'team') throw new S1PilotError('INVALID_STATE', 'Accounts are only available in team mode (S1PILOT_MODE=team)');
}

/** Opens a session for `user`, sets the cookie and writes the login audit entry. */
async function startSession(ctx: Context, user: Parameters<typeof createSession>[1], action: string) {
  const session = await createSession(ctx.db, user, { ip: ctx.request.ip, userAgent: ctx.request.userAgent });
  ctx.request.setCookie?.(sessionCookie(session, ctx.request.secure === true));
  await recordAudit({ ...ctx, user: { id: user.id, role: user.role, name: user.name } }, { action, entityType: 'user', entityId: user.id });
  return toUser(user);
}

/**
 * Sign-in, first-run setup and invite acceptance (S-067). These are the only procedures reachable without a
 * session. In local mode the caller is the implicit admin and none of the account procedures apply.
 */
export const sessionRouter = router({
  /** What the login page needs: mode, whether the first admin must be created, and the SSO button. */
  status: publicProcedure.query(async ({ ctx }) => {
    const team = ctx.config.mode === 'team';
    return {
      mode: ctx.config.mode,
      needsSetup: team && (await ctx.repos.users.count(ctx.db)) === 0,
      authenticated: !ctx.anonymous,
      sso: team && ctx.config.oidc ? { label: ctx.config.oidc.label ?? 'Single sign-on' } : null,
    };
  }),

  /** The signed-in user (`null` when anonymous). Local mode: the implicit admin. */
  me: publicProcedure.query(async ({ ctx }) => {
    if (ctx.anonymous) return null;
    const record = ctx.config.mode === 'team' ? await repos.users.get(ctx.db, ctx.user.id) : undefined;
    return {
      id: ctx.user.id,
      name: ctx.user.name ?? ctx.user.id,
      email: record?.email ?? null,
      role: ctx.user.role as Role,
      mode: ctx.config.mode,
    };
  }),

  login: publicProcedure.input(z.object({ email: EmailSchema, password: z.string().min(1).max(200) })).mutation(async ({ ctx, input }) => {
    requireTeamMode(ctx);
    try {
      const user = await loginWithPassword(ctx.db, { ...input, ip: ctx.request.ip });
      return await startSession(ctx, user, 'auth.login');
    } catch (error) {
      if (error instanceof S1PilotError && error.code === 'UNAUTHORIZED') {
        await recordAudit(ctx, { action: 'auth.login.failed', entityType: 'user', entityId: input.email, after: { reason: error.code } });
      }
      throw error;
    }
  }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    if (ctx.request.sessionId) {
      await repos.users.sessions.delete(ctx.db, ctx.request.sessionId);
      await recordAudit(ctx, { action: 'auth.logout', entityType: 'user', entityId: ctx.user.id });
    }
    ctx.request.setCookie?.(clearedSessionCookie(ctx.request.secure === true));
    return { ok: true as const };
  }),

  /** Creates the first admin of an empty team workspace and signs them in. */
  setup: publicProcedure
    .input(z.object({ email: EmailSchema, name: z.string().trim().min(1).max(80), password: PasswordSchema }))
    .mutation(async ({ ctx, input }) => {
      requireTeamMode(ctx);
      const user = await setupFirstAdmin(ctx.db, input);
      return startSession(ctx, user, 'auth.setup');
    }),

  /** Who an invite link is for (so the accept page can show the email and role). */
  inviteInfo: publicProcedure.input(z.object({ token: z.string().min(10).max(200) })).query(async ({ ctx, input }) => {
    requireTeamMode(ctx);
    const invite = await openInvite(ctx.db, input.token);
    return { email: invite.email, role: RoleSchema.parse(invite.role), expiresAt: invite.expiresAt };
  }),

  acceptInvite: publicProcedure
    .input(z.object({ token: z.string().min(10).max(200), name: z.string().trim().min(1).max(80), password: PasswordSchema }))
    .mutation(async ({ ctx, input }) => {
      requireTeamMode(ctx);
      const user = await acceptInvite(ctx.db, input);
      return startSession(ctx, user, 'auth.invite.accepted');
    }),
});
