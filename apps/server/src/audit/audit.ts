import { newId, type AuditEntry } from '@s1pilot/domain';

import type { Context } from '../trpc/context.js';

const SENSITIVE_KEY = /secret|passw|token|api[-_]?key|authorization|cookie|ciphertext|credential|private|webhook|signature/i;
const MAX_STRING = 500;
const MAX_ITEMS = 50;
const MAX_DEPTH = 6;
export const REDACTED = '[redacted]';

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Copy of `value` that is safe to store in the audit log: values under sensitive keys (secret, password, token,
 * api key, webhook, …) and the `value` of secret variables are replaced, long strings and large arrays are cut.
 */
export function redactForAudit(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => redactForAudit(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `… ${value.length - MAX_ITEMS} more`] : items;
  }
  const secretVariable = value['type' as keyof typeof value] === 'secret';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) || (secretVariable && k === 'value') ? REDACTED : redactForAudit(v, depth + 1);
  }
  return out;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Reduces a before/after pair to the fields that changed (recursing through plain objects; arrays and
 * scalars are compared whole). Both sides are redacted. An absent side stays `null`.
 */
export function auditDiff(before: unknown, after: unknown): { before: unknown; after: unknown } {
  const b = redactForAudit(before);
  const a = redactForAudit(after);
  if (!isPlain(b) || !isPlain(a)) return { before: b ?? null, after: a ?? null };
  const outBefore: Record<string, unknown> = {};
  const outAfter: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (same(b[key], a[key])) continue;
    if (isPlain(b[key]) && isPlain(a[key])) {
      const nested = auditDiff(b[key], a[key]);
      outBefore[key] = nested.before;
      outAfter[key] = nested.after;
    } else {
      if (key in b) outBefore[key] = b[key];
      if (key in a) outAfter[key] = a[key];
    }
  }
  return { before: outBefore, after: outAfter };
}

export interface AuditInput {
  /** Dotted action name, e.g. `case.update`, `secret.reveal`, `run.signoff`. */
  action: string;
  entityType: string;
  entityId: string;
  projectKey?: string | undefined;
  before?: unknown;
  after?: unknown;
}

/** Appends an entry to the audit log. A failed write fails the request: an unaudited change must not succeed silently. */
export async function recordAudit(ctx: Pick<Context, 'db' | 'repos' | 'user' | 'request' | 'log'>, input: AuditInput): Promise<AuditEntry> {
  const diff = auditDiff(input.before, input.after);
  const entry: AuditEntry = {
    id: newId(),
    at: new Date().toISOString(),
    actorId: ctx.user.id,
    actorName: ctx.user.name ?? ctx.user.id,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    projectKey: input.projectKey ?? null,
    before: input.before === undefined ? null : diff.before,
    after: input.after === undefined ? null : diff.after,
    ip: ctx.request.ip ?? null,
  };
  await ctx.repos.audit.append(ctx.db, entry);
  ctx.log.info({ audit: entry.action, actor: entry.actorId, entity: `${entry.entityType}:${entry.entityId}` }, 'audit');
  return entry;
}
