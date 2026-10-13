import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, repos } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { buildProgram } from './program.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function admin(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string }> {
  let out = '';
  let code = 0;
  const program = buildProgram({
    stdout: (t) => void (out += t),
    stderr: (t) => void (out += t),
    setExitCode: (c) => void (code = c),
    exitOverride: true,
    env,
  });
  await program.parseAsync(['admin', 'migrate-sqlite-to-pg', ...args], { from: 'user' });
  return { code, out };
}

describe('s1pilot admin migrate-sqlite-to-pg', () => {
  it('rejects a missing or non-postgres target (exit 3)', async () => {
    expect((await admin(['--from', ':memory:'])).code).toBe(3);
    const res = await admin(['--from', ':memory:', '--to', 'file:./x.db']);
    expect(res.code).toBe(3);
    expect(res.out).toContain('postgres://');
  });

  it('reports an unreachable Postgres as a configuration error (exit 3)', async () => {
    const res = await admin(['--from', ':memory:', '--to', 'postgres://u:p@127.0.0.1:1/none']);
    expect(res.code).toBe(3);
    expect(res.out).toContain('Migration failed');
  });

  // Needs a disposable Postgres: S1PILOT_TEST_PG_URL (CI service container). Its public / pgboss schemas are dropped.
  it.skipIf(!process.env['S1PILOT_TEST_PG_URL'])('copies a seeded SQLite file with identical counts', async () => {
    const url = process.env['S1PILOT_TEST_PG_URL'] as string;
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('drop schema if exists drizzle cascade');
    await pool.query('drop schema public cascade');
    await pool.query('create schema public');
    await pool.end();

    const dir = mkdtempSync(join(tmpdir(), 's1cli-admin-'));
    dirs.push(dir);
    const file = join(dir, 'data.db');
    const db = openDb({ url: `file:${file}` });
    await repos.projects.create(db, { id: newId(), name: 'Shop', key: 'SHOP' });
    db.close();

    const res = await admin(['--from', `file:${file}`, '--to', url, '--json']);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.out) as { identical: boolean; tables: { table: string; source: number; target: number }[] };
    expect(parsed.identical).toBe(true);
    expect(parsed.tables.find((t) => t.table === 'projects')).toMatchObject({ source: 1, target: 1 });
  });
});
