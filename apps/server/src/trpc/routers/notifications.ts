import { IdSchema, S1PilotError, newId } from '@s1pilot/domain';
import { z } from 'zod';

import { deliver, publicBaseUrl } from '../../notifications/service.js';
import {
  ChannelConfigSchema,
  RuleSchema,
  loadChannels,
  loadDeliveryLog,
  loadRules,
  mergeSecrets,
  publicChannel,
  saveChannels,
  saveRules,
} from '../../notifications/store.js';
import { publicProcedure, router } from '../trpc.js';

import { requireSession } from './tokens.js';

/**
 * Notification channels, rules and delivery log (S-065). Channel secrets (webhook URLs, tokens, passwords) are
 * write-only: lists return `secretsSet` flags, never the values. Use `env:NAME` to keep them out of the database.
 */
export const notificationsRouter = router({
  channels: router({
    list: publicProcedure.query(async ({ ctx }) => (await loadChannels(ctx.db)).map(publicChannel)),

    /** Creates a channel, or updates `id` (secrets left empty keep their stored value). */
    save: publicProcedure
      .input(z.object({ id: IdSchema.optional(), name: z.string().trim().min(1).max(80), config: ChannelConfigSchema }))
      .mutation(async ({ ctx, input }) => {
        requireSession(ctx);
        const all = await loadChannels(ctx.db);
        const prev = input.id ? all.find((c) => c.id === input.id) : undefined;
        if (input.id && !prev) throw new S1PilotError('NOT_FOUND', 'Channel not found', { id: input.id });
        const channel = { id: prev?.id ?? newId(), name: input.name, config: mergeSecrets(prev?.config, input.config) };
        if (channel.config.kind === 'slack' && !channel.config.webhookUrl && !(channel.config.botToken && channel.config.channel)) {
          throw new S1PilotError('INVALID_INPUT', 'Slack needs an incoming webhook URL, or a bot token and a channel');
        }
        await saveChannels(ctx.db, prev ? all.map((c) => (c.id === prev.id ? channel : c)) : [...all, channel]);
        return publicChannel(channel);
      }),

    /** Deletes a channel and the rules that use it. */
    delete: publicProcedure.input(z.object({ id: IdSchema })).mutation(async ({ ctx, input }) => {
      requireSession(ctx);
      await saveChannels(ctx.db, (await loadChannels(ctx.db)).filter((c) => c.id !== input.id));
      await saveRules(ctx.db, (await loadRules(ctx.db)).filter((r) => r.channelId !== input.id));
      return { ok: true as const };
    }),

    /** Sends a sample message (retried and logged like a real one). */
    test: publicProcedure.input(z.object({ id: IdSchema })).mutation(async ({ ctx, input }) => {
      requireSession(ctx);
      const channel = (await loadChannels(ctx.db)).find((c) => c.id === input.id);
      if (!channel) throw new S1PilotError('NOT_FOUND', 'Channel not found', { id: input.id });
      const base = await publicBaseUrl(ctx.db, ctx.config);
      return deliver(ctx, channel, {
        type: 'run.finished',
        projectKey: 'TEST',
        runId: 'test',
        planName: 'Test notification',
        status: 'passed',
        summary: { passed: 1, failed: 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 },
        url: base,
      });
    }),
  }),

  rules: router({
    list: publicProcedure.query(({ ctx }) => loadRules(ctx.db)),

    save: publicProcedure.input(RuleSchema.partial({ id: true })).mutation(async ({ ctx, input }) => {
      requireSession(ctx);
      if (!(await loadChannels(ctx.db)).some((c) => c.id === input.channelId)) throw new S1PilotError('NOT_FOUND', 'Channel not found', { id: input.channelId });
      const all = await loadRules(ctx.db);
      const rule = RuleSchema.parse({ ...input, id: input.id ?? newId() });
      await saveRules(ctx.db, all.some((r) => r.id === rule.id) ? all.map((r) => (r.id === rule.id ? rule : r)) : [...all, rule]);
      return rule;
    }),

    delete: publicProcedure.input(z.object({ id: IdSchema })).mutation(async ({ ctx, input }) => {
      requireSession(ctx);
      await saveRules(ctx.db, (await loadRules(ctx.db)).filter((r) => r.id !== input.id));
      return { ok: true as const };
    }),
  }),

  /** Last 100 deliveries, newest first. */
  log: publicProcedure.query(({ ctx }) => loadDeliveryLog(ctx.db)),
});
