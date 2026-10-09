import { repos, type Db } from '@s1pilot/db';
import { IdSchema, ProjectKeySchema } from '@s1pilot/domain';
import { NOTIFICATION_EVENTS } from '@s1pilot/integrations';
import { z } from 'zod';

/**
 * Secret-bearing values are either literals stored server side (never returned to the UI) or `env:NAME`
 * references resolved at send time.
 */
const Secret = z.string().min(1).max(2000);

export const ChannelConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slack'), webhookUrl: Secret.optional(), botToken: Secret.optional(), channel: z.string().max(100).optional() }),
  z.object({ kind: z.literal('teams'), webhookUrl: Secret }),
  z.object({
    kind: z.literal('email'),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    user: z.string().max(255).optional(),
    pass: Secret.optional(),
    from: z.string().min(3).max(255),
    to: z.array(z.string().min(3).max(255)).min(1).max(20),
  }),
  z.object({ kind: z.literal('webhook'), url: Secret, secret: Secret.optional() }),
]);
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;

export const ChannelSchema = z.object({ id: IdSchema, name: z.string().trim().min(1).max(80), config: ChannelConfigSchema });
export type Channel = z.infer<typeof ChannelSchema>;

export const RuleSchema = z.object({
  id: IdSchema,
  channelId: IdSchema,
  /** `null` = every project. */
  projectKey: ProjectKeySchema.nullable().default(null),
  /** `null` = every plan (and runs without a plan). */
  planId: IdSchema.nullable().default(null),
  events: z.array(z.enum(NOTIFICATION_EVENTS)).min(1),
  onlyOnFailure: z.boolean().default(false),
  /** `review.threshold` fires when the pending count first exceeds this. */
  reviewThreshold: z.number().int().min(1).max(10_000).default(10),
});
export type Rule = z.infer<typeof RuleSchema>;

export const DeliveryLogEntrySchema = z.object({
  id: IdSchema,
  at: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  event: z.string(),
  ok: z.boolean(),
  attempts: z.number().int(),
  error: z.string().optional(),
});
export type DeliveryLogEntry = z.infer<typeof DeliveryLogEntrySchema>;

const CHANNELS_KEY = 'notifications.channels';
const RULES_KEY = 'notifications.rules';
const LOG_KEY = 'notifications.log';
/** Delivery log size. */
export const DELIVERY_LOG_LIMIT = 100;

export async function loadChannels(db: Db): Promise<Channel[]> {
  return z.array(ChannelSchema).catch([]).parse(await repos.settings.get(db, CHANNELS_KEY));
}
export const saveChannels = (db: Db, v: Channel[]): Promise<void> => repos.settings.set(db, CHANNELS_KEY, v);

export async function loadRules(db: Db): Promise<Rule[]> {
  return z.array(RuleSchema).catch([]).parse(await repos.settings.get(db, RULES_KEY));
}
export const saveRules = (db: Db, v: Rule[]): Promise<void> => repos.settings.set(db, RULES_KEY, v);

/** Newest first. */
export async function loadDeliveryLog(db: Db): Promise<DeliveryLogEntry[]> {
  return z.array(DeliveryLogEntrySchema).catch([]).parse(await repos.settings.get(db, LOG_KEY));
}
export async function appendDelivery(db: Db, entry: DeliveryLogEntry): Promise<void> {
  const log = await loadDeliveryLog(db);
  await repos.settings.set(db, LOG_KEY, [entry, ...log].slice(0, DELIVERY_LOG_LIMIT));
}

/** Names of the secret fields per channel kind (masked in API output). */
const SECRET_FIELDS: Record<ChannelConfig['kind'], string[]> = {
  slack: ['webhookUrl', 'botToken'],
  teams: ['webhookUrl'],
  email: ['pass'],
  webhook: ['url', 'secret'],
};

/** Channel as shown to the UI: secret fields are replaced by `set` flags. */
export function publicChannel(c: Channel): { id: string; name: string; kind: ChannelConfig['kind']; config: Record<string, unknown>; secretsSet: Record<string, boolean> } {
  const secrets = SECRET_FIELDS[c.config.kind];
  const config: Record<string, unknown> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(c.config)) {
    if (secrets.includes(k)) secretsSet[k] = typeof v === 'string' && v !== '';
    else config[k] = v;
  }
  for (const k of secrets) secretsSet[k] ??= false;
  return { id: c.id, name: c.name, kind: c.config.kind, config, secretsSet };
}

/** Keeps stored secrets when an update leaves them out (the UI never receives them). */
export function mergeSecrets(prev: ChannelConfig | undefined, next: ChannelConfig): ChannelConfig {
  if (!prev || prev.kind !== next.kind) return next;
  const merged: Record<string, unknown> = { ...next };
  for (const k of SECRET_FIELDS[next.kind]) {
    if ((merged[k] === undefined || merged[k] === '') && (prev as Record<string, unknown>)[k] !== undefined) merged[k] = (prev as Record<string, unknown>)[k];
  }
  return merged as ChannelConfig;
}
