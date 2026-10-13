import { S1PilotError } from '@s1pilot/domain';
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig, SQLiteTable, type SQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { PgDb } from './db-pg.js';
import type { Db } from './db.js';
import * as sqliteSchema from './schema/index.js';
import * as pgSchema from './schema-pg/index.js';

/** Row counts of one table before and after the copy. */
export interface CopiedTable {
  table: string;
  source: number;
  target: number;
}

/** Result of {@link copySqliteToPg}. */
export interface CopyResult {
  tables: CopiedTable[];
  /** True when every table has the same count on both sides. */
  identical: boolean;
}

type AnyRow = Record<string, unknown>;

/** SQLite tables ordered so that every table follows the tables it references (self references are fine). */
function orderedTables(): SQLiteTable[] {
  const tables = (Object.values(sqliteSchema) as unknown[]).filter((v): v is SQLiteTable => is(v, SQLiteTable));
  const byName = new Map(tables.map((t) => [getTableName(t), t]));
  const ordered: SQLiteTable[] = [];
  const seen = new Set<string>();
  const visit = (t: SQLiteTable): void => {
    const name: string = getTableName(t);
    if (seen.has(name)) return;
    seen.add(name);
    for (const fk of getTableConfig(t).foreignKeys) {
      const target = byName.get(getTableName(fk.reference().foreignTable));
      if (target && target !== t) visit(target);
    }
    ordered.push(t);
  };
  tables.forEach(visit);
  return ordered;
}

/** Orders rows so a row's parent (through a self-referencing FK column) is inserted before it. */
function parentsFirst(table: SQLiteTable, rows: AnyRow[]): AnyRow[] {
  const config = getTableConfig(table);
  const self = config.foreignKeys.find((fk) => getTableName(fk.reference().foreignTable) === config.name);
  if (!self) return rows;
  const column = self.reference().columns[0] as SQLiteColumn;
  const pk = config.columns.find((c) => c.primary);
  if (!pk) return rows;
  const out: AnyRow[] = [];
  const done = new Set<unknown>();
  let pending = rows;
  while (pending.length > 0) {
    const next = pending.filter((r) => {
      const parent = r[keyOf(table, column)];
      return parent === null || parent === undefined || done.has(parent);
    });
    if (next.length === 0) throw new S1PilotError('CONFLICT', `Cyclic parent references in ${config.name}`);
    for (const r of next) {
      out.push(r);
      done.add(r[keyOf(table, pk)]);
    }
    pending = pending.filter((r) => !next.includes(r));
  }
  return out;
}

/** The property name (as drizzle returns it in a row) of a column. */
function keyOf(table: SQLiteTable, column: SQLiteColumn): string {
  const entry = Object.entries(table).find(([, v]) => v === column);
  return entry ? entry[0] : column.name;
}

/**
 * Copies every table of a SQLite database into an empty Postgres database (already migrated by `openPgDb`),
 * preserving ids and values, inside one transaction. Throws `CONFLICT` when a target table already has rows.
 * Returns per-table counts of both sides so callers can check they are identical.
 */
export async function copySqliteToPg(source: Db, target: PgDb, opts: { chunk?: number } = {}): Promise<CopyResult> {
  const pgTables = new Map(
    (Object.values(pgSchema) as unknown[])
      .filter((v): v is PgTable => is(v, PgTable))
      .map((v) => [getTableName(v) as string, v] as const),
  );
  const tables = orderedTables();

  for (const t of tables) {
    const pgTable = pgTables.get(getTableName(t) as string);
    if (!pgTable) throw new S1PilotError('CONFIG_ERROR', `Postgres schema is missing table ${getTableName(t)}`);
    const res = await target.pool.query<{ n: string }>(`select count(*)::text as n from "${getTableName(t)}"`);
    if (Number(res.rows[0]?.n ?? 0) > 0) {
      throw new S1PilotError('CONFLICT', `Target table ${getTableName(t)} is not empty; migrate into a fresh database`);
    }
  }

  const result: CopiedTable[] = [];
  await target.orm.transaction(async (tx) => {
    for (const t of tables) {
      const name: string = getTableName(t);
      const pgTable = pgTables.get(name) as PgTable;
      const rows = parentsFirst(t, source.orm.select().from(t).all() as AnyRow[]);
      const columns = getTableConfig(t).columns.length;
      const size = Math.max(1, Math.min(opts.chunk ?? 500, Math.floor(60_000 / columns)));
      for (let i = 0; i < rows.length; i += size) {
        await tx.insert(pgTable).values(rows.slice(i, i + size) as never);
      }
      const counted = await tx.execute(sql.raw(`select count(*)::text as n from "${name}"`));
      result.push({ table: name, source: rows.length, target: Number((counted.rows[0] as { n: string }).n) });
    }
  });
  return { tables: result, identical: result.every((r) => r.source === r.target) };
}
