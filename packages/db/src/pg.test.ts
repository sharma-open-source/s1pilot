import { newId } from '@s1pilot/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, openPgDb, isPostgresUrl, type PgDb } from './db-pg.js';
import { openDb } from './db.js';
import { copySqliteToPg } from './migrate-to-pg.js';
import { createPgBossQueue } from './pg-queue.js';
import type { JobQueue } from './queue.js';
import { createSqliteJobQueue } from './queue.js';
import { repos } from './repos/index.js';
import { seedDemo } from './seed.js';
import { stubCrypto } from './test-utils.js';

/**
 * Postgres backend tests. They need a database and are skipped unless `S1PILOT_TEST_PG_URL` points at an empty,
 * disposable one (CI provides a service container; locally `docker run -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres:16`).
 * WARNING: the `public` and `pgboss` schemas of that database are dropped before the tests run.
 */
const url = process.env['S1PILOT_TEST_PG_URL'];
const maybe = url ? describe : describe.skip;

async function reset(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString });
  try {
    await pool.query('drop schema if exists pgboss cascade');
    await pool.query('drop schema if exists drizzle cascade');
    await pool.query('drop schema public cascade');
    await pool.query('create schema public');
  } finally {
    await pool.end();
  }
}

describe('database url selection', () => {
  it('recognises postgres urls', () => {
    expect(isPostgresUrl('postgres://u:p@host/db')).toBe(true);
    expect(isPostgresUrl('postgresql://host/db')).toBe(true);
    expect(isPostgresUrl('file:./data.db')).toBe(false);
    expect(isPostgresUrl(':memory:')).toBe(false);
  });

  it('openDb refuses postgres urls and openDatabase returns a sqlite handle for files', async () => {
    expect(() => openDb({ url: 'postgres://localhost/x' })).toThrow(/openDatabase/);
    const db = await openDatabase({ url: ':memory:' });
    expect('sqlite' in db).toBe(true);
    (db as { close(): void }).close();
  });
});

maybe('postgres backend', () => {
  let pgDb: PgDb;

  beforeAll(async () => {
    await reset(url as string);
    pgDb = await openPgDb({ url: url as string, crypto: stubCrypto });
  });
  afterAll(async () => {
    await pgDb?.close();
  });

  it('migrates the schema and selects the driver from the url', async () => {
    const opened = await openDatabase({ url: url as string, crypto: stubCrypto });
    expect('pool' in opened).toBe(true);
    await (opened as PgDb).close();
    const res = await pgDb.pool.query<{ n: string }>("select count(*)::text as n from information_schema.tables where table_schema = 'public'");
    expect(Number(res.rows[0]?.n)).toBeGreaterThanOrEqual(29);
  });

  it('copies a seeded sqlite database with identical counts and ids', async () => {
    const sqlite = openDb({ url: ':memory:', crypto: stubCrypto });
    const project = await seedDemo(sqlite);
    const parent = (await repos.suites.listByProject(sqlite, project.id))[0];
    await repos.suites.create(sqlite, { id: newId(), projectId: project.id, parentId: parent?.id as string, name: 'Nested' });
    await repos.runs.create(sqlite, { id: newId(), projectId: project.id, trigger: 'manual', status: 'queued' });
    await repos.settings.set(sqlite, 'workspace.name', { name: 'Acme', nested: [1, 2, { ok: true }] });
    await createSqliteJobQueue(sqlite).enqueue({ type: 'run-case', runId: 'r1', payload: { a: 1 } });
    const result = await copySqliteToPg(sqlite, pgDb);
    expect(result.identical).toBe(true);
    const counts = new Map(result.tables.map((t) => [t.table, t.source]));
    expect(counts.get('projects')).toBeGreaterThan(0);
    expect(counts.get('test_cases')).toBeGreaterThan(0);
    expect(counts.get('test_runs')).toBe(1);
    expect(counts.get('suites')).toBe(2);
    expect(counts.get('jobs')).toBe(1);
    const setting = await pgDb.pool.query<{ value: unknown }>("select value from settings where key = 'workspace.name'");
    expect(setting.rows[0]?.value).toEqual({ name: 'Acme', nested: [1, 2, { ok: true }] });

    const sourceProject = sqlite.sqlite.prepare('select id, key from projects').all() as { id: string; key: string }[];
    const copied = await pgDb.pool.query<{ id: string; key: string }>('select id, key from projects order by id');
    expect(copied.rows).toEqual([...sourceProject].sort((a, b) => a.id.localeCompare(b.id)));

    // A second copy into a non-empty database is refused rather than duplicating rows.
    await expect(copySqliteToPg(sqlite, pgDb)).rejects.toMatchObject({ code: 'CONFLICT' });
    sqlite.close();
  });

  describe('pg-boss queue', () => {
    const queues: JobQueue[] = [];
    const make = (opts: { leaseMs?: number } = {}): JobQueue => {
      const q = createPgBossQueue({ connectionString: url as string, reapIntervalMs: 0, ...opts });
      queues.push(q);
      return q;
    };
    afterAll(async () => {
      await Promise.all(queues.map((q) => q.close?.()));
    });

    it('claims in order, once, and completes with a result', async () => {
      const queue = make();
      const a = await queue.enqueue({ type: 'order-test', payload: { n: 1 } });
      expect(a).toMatchObject({ status: 'queued', attempts: 0, maxAttempts: 2, type: 'order-test' });
      const claimed = await queue.claim('w1', { types: ['order-test'] });
      expect(claimed).toMatchObject({ id: a.id, status: 'running', attempts: 1, workerId: 'w1', payload: { n: 1 } });
      expect(await queue.claim('w2', { types: ['order-test'] })).toBeUndefined();
      expect(await queue.complete(a.id, 'w2')).toBe(false);
      expect(await queue.heartbeat(a.id, 'w1')).toBe(true);
      expect(await queue.complete(a.id, 'w1', { ok: true })).toBe(true);
      expect(await queue.get(a.id)).toMatchObject({ status: 'completed', result: { ok: true } });
    });

    it('retries a failed job once when asked, then fails it for good', async () => {
      const queue = make();
      const job = await queue.enqueue({ type: 'retry-test', payload: {}, maxAttempts: 2 });
      await queue.claim('w', { types: ['retry-test'] });
      expect(await queue.fail(job.id, 'w', 'boom', { retry: true })).toBe(true);
      expect((await queue.get(job.id))?.status).toBe('queued');
      expect(await queue.claim('w', { types: ['retry-test'] })).toMatchObject({ id: job.id, attempts: 2 });
      await queue.fail(job.id, 'w', 'boom again', { retry: true });
      expect(await queue.get(job.id)).toMatchObject({ status: 'failed', error: 'boom again' });
    });

    it('fail() without retry is terminal', async () => {
      const queue = make();
      const job = await queue.enqueue({ type: 'noretry-test', payload: {} });
      await queue.claim('w', { types: ['noretry-test'] });
      await queue.fail(job.id, 'w', 'nope');
      expect(await queue.get(job.id)).toMatchObject({ status: 'failed', error: 'nope' });
    });

    it('skips excluded runs and cancels by run', async () => {
      const queue = make();
      const a = await queue.enqueue({ type: 'run-test', runId: 'r1', payload: {} });
      const b = await queue.enqueue({ type: 'run-test', runId: 'r2', payload: {} });
      expect((await queue.claim('w', { types: ['run-test'], excludeRunIds: ['r1'] }))?.id).toBe(b.id);
      const affected = await queue.cancelByRun('r1');
      expect(affected.map((j) => j.id)).toEqual([a.id]);
      expect((await queue.listByRun('r1')).map((j) => j.status)).toEqual(['cancelled']);
      expect(await queue.cancel(a.id)).toBe(false);
      expect(await queue.cancel(b.id)).toBe(true);
    });

    it('two instances sharing the queue never process a job twice', async () => {
      const one = make();
      const two = make();
      const total = 20;
      const ids = new Set<string>();
      for (let i = 0; i < total; i++) ids.add((await one.enqueue({ type: 'shared-test', payload: { i } })).id);

      const seen: string[] = [];
      const drain = async (queue: JobQueue, worker: string): Promise<void> => {
        for (;;) {
          const job = await queue.claim(worker, { types: ['shared-test'] });
          if (!job) return;
          seen.push(job.id);
          await queue.complete(job.id, worker);
        }
      };
      await Promise.all([drain(one, 'a'), drain(two, 'b'), drain(one, 'c'), drain(two, 'd')]);
      expect(seen.length).toBe(total);
      expect(new Set(seen)).toEqual(ids);
    });
  });
});
