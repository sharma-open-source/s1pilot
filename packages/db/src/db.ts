import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema/index.js';

/** Encrypts/decrypts secret variable values. The real implementation comes from S-004. */
export interface SecretCrypto {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/** Test stub only: stores values unchanged. Never use outside tests. */
export const identityCrypto: SecretCrypto = {
  encrypt: (plaintext) => plaintext,
  decrypt: (ciphertext) => ciphertext,
};

/** Open database handle passed to every repository function. */
export interface Db {
  readonly orm: BetterSQLite3Database<typeof schema>;
  readonly sqlite: Database.Database;
  readonly crypto: SecretCrypto;
  /** Serialises `withTx` callers on this connection. */
  txQueue: Promise<unknown>;
  close(): void;
}

export interface OpenDbOptions {
  /** `file:./.s1pilot/data.db`, a bare file path, or `:memory:`. */
  url: string;
  /** Required for secret variables; defaults to a stub that refuses to encrypt. */
  crypto?: SecretCrypto;
}

const refusingCrypto: SecretCrypto = {
  encrypt: () => {
    throw new Error('No SecretCrypto configured: pass `crypto` to openDb to store secret variables');
  },
  decrypt: () => {
    throw new Error('No SecretCrypto configured: pass `crypto` to openDb to read secret variables');
  },
};

/**
 * Opens (creating if needed) a SQLite database, enables foreign keys and runs pending migrations.
 */
export function openDb(opts: OpenDbOptions): Db {
  const path = opts.url.startsWith('file:') ? opts.url.slice('file:'.length) : opts.url;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');
  if (path !== ':memory:') sqlite.pragma('journal_mode = WAL');

  const orm = drizzle(sqlite, { schema });
  // Resolves to packages/db/drizzle from both src/ and dist/.
  migrate(orm, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });

  return {
    orm,
    sqlite,
    crypto: opts.crypto ?? refusingCrypto,
    txQueue: Promise.resolve(),
    close: () => sqlite.close(),
  };
}

/**
 * Runs `fn` synchronously inside a transaction (a savepoint when already inside one).
 * Used by repositories for multi-statement writes; keeps case-number allocation race-free.
 */
export function atomic<T>(db: Db, fn: () => T): T {
  return db.sqlite.transaction(fn)();
}

/**
 * Runs `fn` in a transaction: commits when it resolves, rolls back when it throws.
 * Callers are serialised per connection, so do not call `withTx` from inside `fn`.
 */
export async function withTx<T>(db: Db, fn: (tx: Db) => Promise<T> | T): Promise<T> {
  const run = async (): Promise<T> => {
    db.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(db);
      db.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      db.sqlite.exec('ROLLBACK');
      throw error;
    }
  };
  const next = db.txQueue.then(run, run);
  db.txQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
