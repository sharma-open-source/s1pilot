import { fileURLToPath } from 'node:url';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { openDb, refusingCrypto, type Db, type OpenDbOptions, type SecretCrypto } from './db.js';
import * as pgSchema from './schema-pg/index.js';

/** Open Postgres handle (team mode). Mirrors {@link Db} but every operation is asynchronous. */
export interface PgDb {
  readonly dialect: 'postgres';
  readonly orm: NodePgDatabase<typeof pgSchema>;
  readonly pool: pg.Pool;
  readonly crypto: SecretCrypto;
  close(): Promise<void>;
}

/** True for `postgres://…` / `postgresql://…` URLs. */
export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url);
}

/** Folder with the Postgres SQL migrations (`packages/db/migrations/pg`), resolved from both src/ and dist/. */
export function pgMigrationsFolder(): string {
  return fileURLToPath(new URL('../migrations/pg', import.meta.url));
}

/** Opens a Postgres database with node-postgres and runs pending migrations. */
export async function openPgDb(opts: OpenDbOptions & { max?: number }): Promise<PgDb> {
  const pool = new pg.Pool({ connectionString: opts.url, max: opts.max ?? 10 });
  // An idle client error must not crash the process.
  pool.on('error', () => undefined);
  const orm = drizzle(pool, { schema: pgSchema });
  try {
    await migrate(orm, { migrationsFolder: pgMigrationsFolder() });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  return {
    dialect: 'postgres',
    orm,
    pool,
    crypto: opts.crypto ?? refusingCrypto,
    close: () => pool.end(),
  };
}

/**
 * Opens the database named by `url`: SQLite (`file:…`, a path, `:memory:`) or Postgres (`postgres://…`).
 * The repositories (`repos`) still take the SQLite {@link Db}; the Postgres handle serves the schema, migrations,
 * the pg-boss queue and the SQLite -> Postgres copy tool (see S-066 notes in docs/STATUS.md).
 */
export async function openDatabase(opts: OpenDbOptions): Promise<Db | PgDb> {
  return isPostgresUrl(opts.url) ? openPgDb(opts) : openDb(opts);
}
