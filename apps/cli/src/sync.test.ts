import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, repos } from '@s1pilot/db';
import { newId } from '@s1pilot/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { buildProgram } from './program.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function sync(root: string, ...args: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  let code = 0;
  const program = buildProgram({
    stdout: (t) => void (out += t),
    stderr: (t) => void (out += t),
    setExitCode: (c) => void (code = c),
    exitOverride: true,
  });
  await program.parseAsync(['sync', ...args, '--dir', root], { from: 'user' });
  return { code, out };
}

describe('s1pilot sync', () => {
  it('exports, reports status, imports an edit and flags conflicts', async () => {
    const root = mkdtempSync(join(tmpdir(), 's1cli-sync-'));
    dirs.push(root);
    const db = openDb({ url: join(root, '.s1pilot', 'data.db') });
    const project = await repos.projects.create(db, { id: newId(), name: 'Shop', key: 'SHOP' });
    const c = await repos.cases.create(db, project.id, {
      title: 'Home loads',
      priority: 'P2',
      type: 'smoke',
      status: 'ready',
      steps: [{ action: 'Open the home page' }],
    });
    db.close();

    expect((await sync(root, 'status')).code).toBe(1);
    expect((await sync(root, 'export')).code).toBe(0);
    const status = await sync(root, 'status');
    expect(status).toEqual({ code: 0, out: 'Synced with .s1pilot/ in git · clean\n' });

    const file = join(root, '.s1pilot', 'suites', 'shop-tc-1-home-loads.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('Open the home page', 'Open the landing page'));
    const dry = await sync(root, 'import', '--dry-run');
    expect(dry.out).toContain('would update case SHOP-TC-1');

    expect((await sync(root, 'import')).code).toBe(0);
    const db2 = openDb({ url: join(root, '.s1pilot', 'data.db') });
    expect((await repos.cases.get(db2, c.id))?.version).toBe(2);
    await repos.cases.update(db2, c.id, { title: 'Newer in DB' });
    db2.close();

    writeFileSync(file, readFileSync(file, 'utf8').replace('Open the landing page', 'Open the start page'));
    const conflict = await sync(root, 'import');
    expect(conflict.code).toBe(1);
    expect(conflict.out).toContain('CONFLICT case SHOP-TC-1');
    expect(conflict.out).toContain('-title: Newer in DB');
  });
});
