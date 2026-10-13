import { IdSchema, RoleSchema, S1PilotError } from '@s1pilot/domain';
import { z } from 'zod';

import { recordAudit } from '../../audit/audit.js';
import { changeRole, createInvite, setUserStatus, toUser } from '../../auth/accounts.js';
import { EmailSchema } from '../../auth/credentials.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

function requireTeamMode(ctx: Context): void {
  if (ctx.config.mode !== 'team') throw new S1PilotError('INVALID_STATE', 'Users and roles are only available in team mode (S1PILOT_MODE=team)');
}

/** Origin used in invite links: the configured public URL, else the origin the admin is browsing from. */
function baseUrl(ctx: Context): string {
  if (ctx.config.publicUrl) return ctx.config.publicUrl.replace(/\/$/, '');
  if (ctx.request.origin) return ctx.request.origin.replace(/\/$/, '');
  return `${ctx.request.secure ? 'https' : 'http'}://${ctx.request.host ?? `${ctx.config.host}:${ctx.config.port}`}`;
}

const userView = (u: Parameters<typeof toUser>[0]) => ({ email: u.email, role: u.role, status: u.status });

/** Users & roles (S-067). Needs `users:manage` (admin) except `options`. */
export const usersRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    requireTeamMode(ctx);
    const invites = await ctx.repos.users.invites.listOpen(ctx.db);
    const now = new Date().toISOString();
    return {
      users: (await ctx.repos.users.list(ctx.db)).map(toUser),
      invites: invites.filter((i) => i.expiresAt > now).map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: i.createdAt, expiresAt: i.expiresAt })),
    };
  }),

  /** Active users for owner / assignee pickers. Available to every signed-in role. */
  options: publicProcedure.query(async ({ ctx }) => {
    if (ctx.config.mode !== 'team') return [{ id: ctx.user.id, name: ctx.user.name ?? ctx.user.id, email: null as string | null }];
    return (await ctx.repos.users.list(ctx.db)).filter((u) => u.status === 'active').map((u) => ({ id: u.id, name: u.name, email: u.email as string | null }));
  }),

  /** Creates an invite link. The link is shown once; only a hash of its token is stored. */
  invite: publicProcedure.input(z.object({ email: EmailSchema, role: RoleSchema })).mutation(async ({ ctx, input }) => {
    requireTeamMode(ctx);
    const { invite, token } = await createInvite(ctx.db, { ...input, createdBy: ctx.user.id });
    await recordAudit(ctx, { action: 'user.invite', entityType: 'invite', entityId: invite.id, after: { email: invite.email, role: invite.role } });
    return { invite: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt }, inviteUrl: `${baseUrl(ctx)}/invite/${token}` };
  }),

  revokeInvite: publicProcedure.input(z.object({ id: IdSchema })).mutation(async ({ ctx, input }) => {
    requireTeamMode(ctx);
    const invite = await ctx.repos.users.invites.get(ctx.db, input.id);
    if (!invite) throw new S1PilotError('NOT_FOUND', 'Invite not found', { id: input.id });
    await ctx.repos.users.invites.revoke(ctx.db, input.id, new Date().toISOString());
    await recordAudit(ctx, { action: 'user.invite.revoke', entityType: 'invite', entityId: input.id, after: { email: invite.email } });
    return { ok: true as const };
  }),

  setRole: publicProcedure.input(z.object({ id: IdSchema, role: RoleSchema })).mutation(async ({ ctx, input }) => {
    requireTeamMode(ctx);
    const { before, after } = await changeRole(ctx.db, input.id, input.role);
    await recordAudit(ctx, { action: 'user.role', entityType: 'user', entityId: input.id, before: userView(before), after: userView(after) });
    return toUser(after);
  }),

  /** Deactivating ends the user's sessions at once. You cannot deactivate yourself. */
  setStatus: publicProcedure.input(z.object({ id: IdSchema, status: z.enum(['active', 'deactivated']) })).mutation(async ({ ctx, input }) => {
    requireTeamMode(ctx);
    if (input.id === ctx.user.id && input.status === 'deactivated') throw new S1PilotError('INVALID_STATE', 'You cannot deactivate your own account');
    const { before, after } = await setUserStatus(ctx.db, input.id, input.status);
    await recordAudit(ctx, {
      action: input.status === 'deactivated' ? 'user.deactivate' : 'user.activate',
      entityType: 'user',
      entityId: input.id,
      before: userView(before),
      after: userView(after),
    });
    return toUser(after);
  }),
});
