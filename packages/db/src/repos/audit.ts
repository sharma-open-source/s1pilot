import type { AuditEntry } from '@s1pilot/domain';
import { and, desc, eq, gte, like, lt, lte, or, type SQL } from 'drizzle-orm';

import type { Db } from '../db.js';
import { auditLog as t } from '../schema/index.js';

/** Filters of the audit log table. `from` / `to` are inclusive ISO timestamps; `q` matches actor, action and entity id. */
export interface AuditFilter {
  actorId?: string | undefined;
  action?: string | undefined;
  entityType?: string | undefined;
  projectKey?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function where(f: AuditFilter): SQL | undefined {
  const parts: Array<SQL | undefined> = [
    f.actorId ? eq(t.actorId, f.actorId) : undefined,
    f.action ? (f.action.endsWith('*') ? like(t.action, `${escapeLike(f.action.slice(0, -1))}%`) : eq(t.action, f.action)) : undefined,
    f.entityType ? eq(t.entityType, f.entityType) : undefined,
    f.projectKey ? eq(t.projectKey, f.projectKey) : undefined,
    f.from ? gte(t.at, f.from) : undefined,
    f.to ? lte(t.at, f.to) : undefined,
    f.q
      ? or(
          like(t.actorName, `%${escapeLike(f.q)}%`),
          like(t.action, `%${escapeLike(f.q)}%`),
          like(t.entityId, `%${escapeLike(f.q)}%`),
        )
      : undefined,
  ];
  return and(...parts);
}

/** Append-only audit log (S-067). There is deliberately no update or delete. */
export const audit = {
  async append(db: Db, entry: AuditEntry): Promise<void> {
    db.orm.insert(t).values(entry).run();
  },

  /** Newest first. `before` is a keyset cursor (`at` of the last row of the previous page). */
  async list(db: Db, filter: AuditFilter = {}, opts: { limit?: number; before?: string } = {}): Promise<AuditEntry[]> {
    const cursor = opts.before ? lt(t.at, opts.before) : undefined;
    return db.orm
      .select()
      .from(t)
      .where(and(where(filter), cursor))
      .orderBy(desc(t.at), desc(t.id))
      .limit(opts.limit ?? 50)
      .all() as AuditEntry[];
  },
};
export type AuditRepo = typeof audit;
