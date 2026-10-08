import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, repos, type Db } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { unifiedDiff } from './diff.js';
import { exportProject, importProject, syncStatus } from './sync.js';

const crypto = { encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.slice(4) };
const dirs: string[] = [];
const dbs: Db[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 's1sync-'));
  dirs.push(d);
  return d;
}
function memDb(): Db {
  const db = openDb({ url: ':memory:', crypto });
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const db of dbs.splice(0)) db.close();
});

/** Every file below `dir` as `relative path -> text`. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, snapshot(full, base));
    else out[full.slice(base.length + 1)] = readFileSync(full, 'utf8');
  }
  return out;
}

async function seed(db: Db): Promise<string> {
  const project = await repos.projects.create(db, {
    id: newId(),
    name: 'Shop',
    key: 'SHOP',
    modelSettings: {
      system1: { adapter: 'mock', model: 'mock' },
      thresholds: { act: 0.8, pass: 0.8, fail: 0.2, escalate: 0.5 },
      dualOrderSensitive: false,
    },
  });
  const staging = await repos.environments.create(db, {
    id: newId(),
    projectId: project.id,
    name: 'staging',
    baseUrl: 'https://staging.example.com',
    allowDomains: ['b.example.com', 'a.example.com'],
    variables: [
      { key: 'USER', value: 'tester', secret: false, source: 'inline' },
      { key: 'PASSWORD', value: 'hunter2-plaintext', secret: true, source: 'inline' },
      { key: 'TOKEN', secret: true, source: 'env', envVar: 'STAGING_TOKEN' },
    ],
  });
  await repos.projects.update(db, project.id, { defaultEnvironmentId: staging.id });
  const flow = await repos.sharedSteps.create(db, {
    id: newId(),
    projectId: project.id,
    name: 'clear-cart',
    params: ['sku'],
    steps: [{ action: 'Remove {sku} from the cart', expected: 'Cart is empty', assert: [], inputs: [] }],
  });
  const checkout = await repos.suites.create(db, { id: newId(), projectId: project.id, name: 'Checkout', position: 0 });
  const guest = await repos.suites.create(db, { id: newId(), projectId: project.id, parentId: checkout.id, name: 'Guest', position: 0 });
  const c1 = await repos.cases.create(db, project.id, {
    suiteId: guest.id,
    title: 'Guest can check out',
    priority: 'P1',
    type: 'e2e',
    status: 'ready',
    tags: ['smoke', 'checkout'],
    preconditions: [{ flow: 'clear-cart' }],
    parameters: [{ size: 'M' }, { size: 'L' }],
    steps: [
      { action: 'Open the shop', expected: 'Shop is shown', assert: [{ type: 'urlMatches', pattern: '/shop' }], inputs: [] },
      { action: `Run flow ${flow.name}`, sharedStepId: flow.id, args: { sku: 'tee' }, assert: [], inputs: [] },
    ],
  });
  await repos.cases.create(db, project.id, {
    title: 'Root level case',
    priority: 'P2',
    type: 'smoke',
    status: 'draft',
    steps: [{ action: 'Open the home page', assert: [], inputs: [] }],
  });
  await repos.plans.create(db, {
    id: newId(),
    projectId: project.id,
    name: 'Nightly smoke',
    selection: { kind: 'list', caseIds: [c1.id] },
    matrix: [{ environmentId: staging.id, browser: 'chromium' }],
  });
  return project.id;
}

describe('tests-as-code sync', () => {
  it('exports to the documented layout without secret values', async () => {
    const db = memDb();
    const pid = await seed(db);
    const root = tmp();
    const res = await exportProject(db, pid, root);
    const files = snapshot(join(root, '.s1pilot'));
    expect(Object.keys(files)).toEqual([
      'environments/staging.yaml',
      'flows/clear-cart.yaml',
      'plans/nightly-smoke.yaml',
      'project.yaml',
      'suites/Checkout/Guest/shop-tc-1-guest-can-check-out.yaml',
      'suites/shop-tc-2-root-level-case.yaml',
    ]);
    expect(res.written).toHaveLength(6);
    expect(files['environments/staging.yaml']).toContain('value: env:STAGING_TOKEN');
    expect(JSON.stringify(files)).not.toContain('hunter2');
    expect(files['suites/Checkout/Guest/shop-tc-1-guest-can-check-out.yaml']).toContain('- flow: clear-cart');
    // Sorted lists
    expect(files['suites/Checkout/Guest/shop-tc-1-guest-can-check-out.yaml']).toMatch(/tags:\n {2}- checkout\n {2}- smoke/);
  });

  it('export -> import into an empty DB -> export is byte-identical', async () => {
    const db1 = memDb();
    const pid = await seed(db1);
    const a = tmp();
    await exportProject(db1, pid, a);

    const db2 = memDb();
    const plan = await importProject(db2, a);
    expect(plan.conflicts).toEqual([]);
    expect(plan.creates.map((c) => c.kind).sort()).toEqual(['case', 'case', 'environment', 'flow', 'plan', 'project']);
    const imported = await repos.projects.getByKey(db2, 'SHOP');
    expect(imported).toBeDefined();
    const b = tmp();
    await exportProject(db2, (imported as { id: string }).id, b);
    expect(snapshot(join(b, '.s1pilot'))).toEqual(snapshot(join(a, '.s1pilot')));

    // A second import is a no-op, and status is clean.
    expect(await importProject(db2, a, { dryRun: true })).toEqual({ creates: [], updates: [], conflicts: [], deletes: [] });
    expect(await syncStatus(db2, (imported as { id: string }).id, a)).toBe('clean');
    // New cases keep counting after the imported keys.
    const next = await repos.cases.create(db2, (imported as { id: string }).id, {
      title: 'next',
      priority: 'P2',
      type: 'e2e',
      status: 'draft',
      steps: [{ action: 'x' }],
    });
    expect(next.key).toBe('SHOP-TC-3');
  });

  it('dryRun writes nothing', async () => {
    const db1 = memDb();
    const pid = await seed(db1);
    const a = tmp();
    await exportProject(db1, pid, a);
    const db2 = memDb();
    const plan = await importProject(db2, a, { dryRun: true });
    expect(plan.creates.length).toBeGreaterThan(0);
    expect(await repos.projects.list(db2)).toEqual([]);
  });

  it('editing a step in YAML and importing bumps the case version', async () => {
    const db = memDb();
    const pid = await seed(db);
    const root = tmp();
    await exportProject(db, pid, root);
    const file = join(root, '.s1pilot', 'suites/Checkout/Guest/shop-tc-1-guest-can-check-out.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Open the shop', 'Open the shop front page'));
    expect(await syncStatus(db, pid, root)).toMatchObject({ changedFiles: ['suites/Checkout/Guest/shop-tc-1-guest-can-check-out.yaml'] });

    const plan = await importProject(db, root);
    expect(plan.updates).toEqual([{ kind: 'case', id: 'SHOP-TC-1', file: 'suites/Checkout/Guest/shop-tc-1-guest-can-check-out.yaml' }]);
    const updated = await repos.cases.getByKey(db, 'SHOP-TC-1');
    expect(updated?.version).toBe(2);
    expect(updated?.steps[0]?.action).toBe('Open the shop front page');
    expect(updated?.steps[1]?.sharedStepId).toBeDefined();
    expect((await repos.cases.history(db, updated?.id as string)).map((c) => c.version)).toEqual([2, 1]);
  });

  it('reports a conflict with a diff when the file is based on an older version', async () => {
    const db = memDb();
    const pid = await seed(db);
    const root = tmp();
    await exportProject(db, pid, root); // file based on v1
    const c = (await repos.cases.getByKey(db, 'SHOP-TC-1')) as { id: string };
    await repos.cases.update(db, c.id, { title: 'Guest checkout v2' });
    await repos.cases.update(db, c.id, { title: 'Guest checkout v3' }); // DB v3
    const file = join(root, '.s1pilot', 'suites/Checkout/Guest/shop-tc-1-guest-can-check-out.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Open the shop', 'Open the store'));

    const plan = await importProject(db, root);
    expect(plan.updates).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    const conflict = plan.conflicts[0];
    expect(conflict).toMatchObject({ kind: 'case', id: 'SHOP-TC-1', fileVersion: 1, dbVersion: 3 });
    expect(conflict?.diff).toContain('-title: Guest checkout v3');
    expect(conflict?.diff).toContain('+title: Guest can check out');
    expect(conflict?.diff).toContain('+  - action: Open the store');
    // Never overwrote the newer DB version.
    const after = await repos.cases.getByKey(db, 'SHOP-TC-1');
    expect(after).toMatchObject({ version: 3, title: 'Guest checkout v3' });
    const status = await syncStatus(db, pid, root);
    expect(status).not.toBe('clean');
    expect((status as { conflicts: unknown[] }).conflicts).toHaveLength(1);
  });

  it('does not report a conflict when an older file has identical content', async () => {
    const db = memDb();
    const pid = await seed(db);
    const root = tmp();
    await exportProject(db, pid, root);
    const c = (await repos.cases.getByKey(db, 'SHOP-TC-2')) as { id: string };
    await repos.cases.update(db, c.id, { tags: [] }); // version bump, same content
    const plan = await importProject(db, root, { dryRun: true });
    expect(plan.conflicts).toEqual([]);
    expect(plan.updates).toEqual([]);
  });

  it('lists deletions but only applies them with prune; export removes stale files', async () => {
    const db = memDb();
    const pid = await seed(db);
    const root = tmp();
    await exportProject(db, pid, root);
    const stale = join(root, '.s1pilot', 'suites/shop-tc-2-root-level-case.yaml');
    rmSync(stale);
    const plan = await importProject(db, root);
    expect(plan.deletes.map((d) => d.id)).toEqual(['SHOP-TC-2']);
    expect(await repos.cases.getByKey(db, 'SHOP-TC-2')).toBeDefined();
    await importProject(db, root, { prune: true });
    expect(await repos.cases.getByKey(db, 'SHOP-TC-2')).toBeUndefined();

    // Retitling renames the file on export and removes the old one.
    const c = (await repos.cases.getByKey(db, 'SHOP-TC-1')) as { id: string };
    await repos.cases.update(db, c.id, { title: 'Renamed' });
    const res = await exportProject(db, pid, root);
    expect(res.removed).toEqual(['suites/Checkout/Guest/shop-tc-1-guest-can-check-out.yaml']);
    expect(existsSync(join(root, '.s1pilot', 'suites/Checkout/Guest/shop-tc-1-renamed.yaml'))).toBe(true);
  });

  it('refuses secret values in environment files', async () => {
    const db = memDb();
    const pid = await seed(db);
    const root = tmp();
    await exportProject(db, pid, root);
    const file = join(root, '.s1pilot', 'environments/staging.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('- key: PASSWORD\n    secret: true', '- key: PASSWORD\n    value: oops\n    secret: true'));
    await expect(importProject(db, root, { dryRun: true })).rejects.toMatchObject({ code: 'SECRET_IN_FILE' });
  });

  it('reports files that differ from the DB in status', async () => {
    const db = memDb();
    const pid = await seed(db);
    const root = tmp();
    expect(await syncStatus(db, pid, root)).toMatchObject({ changedFiles: expect.arrayContaining(['project.yaml']) });
    await exportProject(db, pid, root);
    expect(await syncStatus(db, pid, root)).toBe('clean');
  });
});

describe('unifiedDiff', () => {
  it('is empty for equal text and marks changed lines', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x', 'y')).toBe('');
    const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'x', 'y');
    expect(d).toContain('--- x');
    expect(d).toContain('-b');
    expect(d).toContain('+B');
    expect(d).toContain('@@ -1,4 +1,4 @@');
  });
});
