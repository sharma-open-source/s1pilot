import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDb, withTx, type Db } from './db.js';
import { repos } from './repos/index.js';
import { makeProject, memoryDb } from './test-utils.js';

const EXPECTED_TABLES = [
  'workspaces', 'projects', 'environments', 'variables', 'suites', 'test_cases', 'test_case_versions',
  'shared_steps', 'requirements', 'case_requirements', 'test_data_sets', 'learned_scripts',
  'heal_proposals', 'test_plans', 'test_runs', 'case_results', 'step_results', 'decision_records',
  'evidence', 'defects', 'defect_results', 'review_items', 'settings', 'jobs', 'artifacts', 'auth_setups', 'manual_items', 'analytics_daily', 'api_tokens', 'users', 'sessions', 'invites', 'audit_log',
];

function tables(db: Db): string[] {
  return (
    db.sqlite
      .prepare("select name from sqlite_master where type = 'table' and name not like '%drizzle%' and name not like 'sqlite_%'")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe('openDb', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('migrates an empty in-memory database with every table', () => {
    const db = memoryDb();
    expect(tables(db).sort()).toEqual([...EXPECTED_TABLES].sort());
    expect(db.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('creates the file (and parent folders), and re-opening is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's1pilot-db-'));
    dirs.push(dir);
    const url = `file:${join(dir, 'nested', 'data.db')}`;
    const first = openDb({ url });
    await makeProject(first);
    first.close();
    const second = openDb({ url });
    expect(await repos.projects.getByKey(second, 'SHOP')).toBeDefined();
    second.close();
  });
});

describe('withTx', () => {
  it('commits on success and rolls back on error', async () => {
    const db = memoryDb();
    await withTx(db, async (tx) => {
      await repos.settings.set(tx, 'a', 1);
    });
    await expect(
      withTx(db, async (tx) => {
        await repos.settings.set(tx, 'b', 2);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await repos.settings.get(db, 'a')).toBe(1);
    expect(await repos.settings.get(db, 'b')).toBeUndefined();
  });

  it('serialises concurrent transactions', async () => {
    const db = memoryDb();
    await Promise.all(
      [1, 2, 3].map((n) =>
        withTx(db, async (tx) => {
          await new Promise((r) => setTimeout(r, 5));
          await repos.settings.set(tx, `k${n}`, n);
        }),
      ),
    );
    expect(await repos.settings.get(db, 'k3')).toBe(3);
  });
});
