import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { flowLookup, loadDataset, loadFlow, parseCsv } from './flows.js';
import { loadCaseFile } from './load.js';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 's1p-flows-'));
  mkdirSync(join(root, '.s1pilot', 'flows'), { recursive: true });
  mkdirSync(join(root, '.s1pilot', 'data', 'staging'), { recursive: true });
  return root;
}

describe('flows', () => {
  it('loads a flow file as a shared step and rewrites nested flow: steps', () => {
    const root = project();
    writeFileSync(
      join(root, '.s1pilot', 'flows', 'login.yaml'),
      'params: [user]\nsteps:\n  - action: Log in as {user}\n  - flow: clear-cart\n',
    );
    const f = loadFlow(root, 'login');
    expect(f).toMatchObject({ id: 'login', name: 'login', params: ['user'] });
    expect(f.steps[1]).toMatchObject({ sharedStepId: 'clear-cart', action: 'Run flow clear-cart' });
  });

  it('reports missing / invalid flows and rejects path traversal', () => {
    const root = project();
    expect(() => loadFlow(root, 'ghost')).toThrow(/not found/);
    expect(() => loadFlow(root, '../x')).toThrow(/Invalid flow name/);
    writeFileSync(join(root, '.s1pilot', 'flows', 'bad.yaml'), 'steps: []\n');
    expect(() => loadFlow(root, 'bad')).toThrow(/at least one step/);
    expect(flowLookup(root)('ghost')).toBeUndefined();
  });

  it('turns `flow:` steps with args in a case file into reference steps', () => {
    const root = project();
    writeFileSync(join(root, 'tc.yaml'), 'key: A-1\ntitle: t\nsteps:\n  - flow: login\n    args: { user: ann }\n  - action: Go\n');
    const tc = loadCaseFile(join(root, 'tc.yaml'));
    expect(tc.steps[0]).toMatchObject({ sharedStepId: 'login', args: { user: 'ann' } });
  });
});

describe('datasets', () => {
  it('parses quoted CSV', () => {
    expect(parseCsv('name,zip\r\n"Doe, Alex",94105\n"Say ""hi""",1\n\n')).toEqual([
      { name: 'Doe, Alex', zip: '94105' },
      { name: 'Say "hi"', zip: '1' },
    ]);
  });

  it('loads csv/json data sets, preferring the environment folder', () => {
    const root = project();
    const data = join(root, '.s1pilot', 'data');
    writeFileSync(join(data, 'addresses.csv'), 'zip\n111\n');
    writeFileSync(join(data, 'staging', 'addresses.csv'), 'zip\n222\n');
    writeFileSync(join(data, 'sizes.json'), '[{"size":"M"},{"size":"L"}]');
    expect(loadDataset(root, 'addresses.csv')).toEqual([{ zip: '111' }]);
    expect(loadDataset(root, 'addresses.csv', 'staging')).toEqual([{ zip: '222' }]);
    expect(loadDataset(root, 'sizes')).toEqual([{ size: 'M' }, { size: 'L' }]);
    expect(loadDataset(root, 'nope')).toBeUndefined();
    expect(() => loadDataset(root, '../secret.csv')).toThrow(/Invalid/);
  });
});
