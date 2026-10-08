import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FsLearnedScriptStore } from './learned-store.js';

const ref = { caseKey: 'SHOP-TC-42', caseId: 'c1', environmentName: 'local', environmentId: 'e1' };
const script = {
  id: 'l1',
  caseId: 'c1',
  caseVersion: 1,
  environmentId: 'e1',
  createdFromRunId: 'r1',
  health: { healCount: 0, pendingProposals: 0 },
  actions: [{ stepIndex: 0, subIndex: 0, action: 'click' as const, locators: [], fingerprint: 'f', fromRunId: 'r1' }],
};

describe('FsLearnedScriptStore', () => {
  it('round-trips a script under .s1pilot/learned/<caseKey>/<env>.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 's1p-learned-'));
    const store = new FsLearnedScriptStore(root);
    expect(await store.get(ref)).toBeUndefined();
    await store.put(ref, script);
    expect(JSON.parse(readFileSync(join(root, '.s1pilot', 'learned', 'SHOP-TC-42', 'local.json'), 'utf8'))).toMatchObject({ id: 'l1' });
    expect((await store.get(ref))?.actions).toHaveLength(1);
    await store.delete(ref);
    expect(await store.get(ref)).toBeUndefined();
  });
});
