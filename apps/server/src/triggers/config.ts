import { randomBytes, timingSafeEqual } from 'node:crypto';

import { repos, type Db } from '@s1pilot/db';
import { z } from 'zod';

/** Per-plan trigger settings, stored in the settings table under `plan-trigger:<planId>`. */
export const PlanTriggerConfigSchema = z.object({
  /** Secret path segment of the inbound webhook URL. */
  token: z.string().min(16),
  /** IANA timezone for the cron schedule; absent = workspace timezone. */
  timezone: z.string().optional(),
  /** Skip a scheduled run while the previous scheduled run of the same plan is still running. */
  skipIfRunning: z.boolean().default(true),
});
export type PlanTriggerConfig = z.infer<typeof PlanTriggerConfigSchema>;

const key = (planId: string): string => `plan-trigger:${planId}`;

/** Generates an unguessable webhook token. */
export function newToken(): string {
  return randomBytes(24).toString('base64url');
}

/** True when `timezone` is a valid IANA zone. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Workspace default timezone: setting `workspace.timezone`, else the process zone, else UTC. */
export async function workspaceTimezone(db: Db): Promise<string> {
  const v = await repos.settings.get(db, 'workspace.timezone');
  if (typeof v === 'string' && isValidTimezone(v)) return v;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Reads a plan's trigger config; creates it (with a fresh token) when missing. */
export async function getTriggerConfig(db: Db, planId: string): Promise<PlanTriggerConfig> {
  const parsed = PlanTriggerConfigSchema.safeParse(await repos.settings.get(db, key(planId)));
  if (parsed.success) return parsed.data;
  const created = PlanTriggerConfigSchema.parse({ token: newToken() });
  await repos.settings.set(db, key(planId), created);
  return created;
}

/** Merges a patch into the trigger config. */
export async function updateTriggerConfig(
  db: Db,
  planId: string,
  patch: Partial<Omit<PlanTriggerConfig, 'timezone'>> & { timezone?: string | null },
): Promise<PlanTriggerConfig> {
  const { timezone: tzPatch, ...rest } = patch;
  const { timezone: tzCurrent, ...current } = await getTriggerConfig(db, planId);
  const tz = tzPatch === undefined ? tzCurrent : (tzPatch ?? undefined);
  const next = PlanTriggerConfigSchema.parse({ ...current, ...rest, ...(tz !== undefined ? { timezone: tz } : {}) });
  await repos.settings.set(db, key(planId), next);
  return next;
}

/** Issues a new webhook token; the old one stops working. */
export function regenerateToken(db: Db, planId: string): Promise<PlanTriggerConfig> {
  return updateTriggerConfig(db, planId, { token: newToken() });
}

/** Removes a plan's trigger config (plan deleted). */
export async function deleteTriggerConfig(db: Db, planId: string): Promise<void> {
  await repos.settings.delete(db, key(planId));
}

/** Constant-time token check. */
export async function tokenMatches(db: Db, planId: string, token: string): Promise<boolean> {
  const expected = Buffer.from((await getTriggerConfig(db, planId)).token);
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
