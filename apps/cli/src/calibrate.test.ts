import { mkdtempSync, rmSync } from 'node:fs';
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

async function calibrate(root: string, ...args: string[]): Promise<{ code: number; out: string }> {
  let out = '';
  let code = 0;
  const program = buildProgram({
    stdout: (t) => void (out += t),
    stderr: (t) => void (out += t),
    setExitCode: (c) => void (code = c),
    exitOverride: true,
  });
  await program.parseAsync(['calibrate', ...args, '--dir', root], { from: 'user' });
  return { code, out };
}

describe('s1pilot calibrate', () => {
  it('fits from reviewed outcomes and prints models and a suggestion without applying it', async () => {
    const root = mkdtempSync(join(tmpdir(), 's1cli-cal-'));
    dirs.push(root);
    const db = openDb({ url: join(root, '.s1pilot', 'data.db') });
    const project = await repos.projects.create(db, { id: newId(), name: 'Shop', key: 'SHOP' });
    for (let i = 0; i < 80; i++) {
      await repos.reviews.create(db, {
        id: newId(),
        projectId: project.id,
        kind: 'verdict',
        refId: newId(),
        status: 'approved',
        outcome: { pTrue: 0.9, humanVerdict: i < 56 ? 'passed' : 'failed', questionType: 'noul', optionCount: 2, model: 'clef' },
      });
    }
    db.close();

    const res = await calibrate(root, '--project', 'SHOP');
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/Fitted 3 calibration model\(s\) from 80 reviewed/);
    expect(res.out).toMatch(/clef\|noul\|2\s+T=[2-9]\.\d+/);

    const json = await calibrate(root, '--project', 'SHOP', '--json');
    expect(JSON.parse(json.out).models[0].T).toBeGreaterThan(1);

    const missing = await calibrate(root, '--project', 'NOPE');
    expect(missing.code).toBe(3);
  });
});
