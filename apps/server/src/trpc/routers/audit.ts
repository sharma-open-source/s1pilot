import type { AuditEntry } from '@s1pilot/domain';
import { z } from 'zod';

import { publicProcedure, router } from '../trpc.js';

const Filter = z.object({
  actorId: z.string().min(1).optional(),
  /** Exact action, or a prefix ending in `*` (e.g. `case.*`). */
  action: z.string().min(1).max(80).optional(),
  entityType: z.string().min(1).max(40).optional(),
  projectKey: z.string().min(1).max(40).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  q: z.string().trim().min(1).max(100).optional(),
});

export const EXPORT_LIMIT = 10_000;

/** Cell text safe for spreadsheets: quoted, and neutralised against formula injection. */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** CSV of audit entries (header row first), oldest columns first: time, actor, action, entity, project, ip, before, after. */
export function auditCsv(entries: AuditEntry[]): string {
  const header = ['time', 'actor', 'actor_id', 'action', 'entity_type', 'entity_id', 'project', 'ip', 'before', 'after'];
  const rows = entries.map((e) => [e.at, e.actorName, e.actorId, e.action, e.entityType, e.entityId, e.projectKey, e.ip, e.before, e.after].map(csvCell).join(','));
  return [header.join(','), ...rows].join('\r\n') + '\r\n';
}

/** Audit log (S-067). Needs `audit:read` (admin, lead). */
export const auditRouter = router({
  /** Newest first. Pass the returned `nextBefore` as `before` for the next page. */
  list: publicProcedure
    .input(Filter.extend({ limit: z.number().int().min(1).max(200).default(50), before: z.string().datetime().optional() }))
    .query(async ({ ctx, input }) => {
      const { limit, before, ...filter } = input;
      const entries = await ctx.repos.audit.list(ctx.db, filter, { limit: limit + 1, ...(before ? { before } : {}) });
      const page = entries.slice(0, limit);
      return { entries: page, nextBefore: entries.length > limit ? (page[page.length - 1]?.at ?? null) : null };
    }),

  /** The filtered log as CSV (at most {@link EXPORT_LIMIT} newest rows). */
  exportCsv: publicProcedure.input(Filter).query(async ({ ctx, input }) => {
    const entries = await ctx.repos.audit.list(ctx.db, input, { limit: EXPORT_LIMIT });
    return { filename: `audit-log-${new Date().toISOString().slice(0, 10)}.csv`, csv: auditCsv(entries), rows: entries.length };
  }),
});
