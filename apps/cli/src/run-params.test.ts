import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildProgram } from './program.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let server: FixtureServer;
beforeAll(async () => {
  server = await startFixtureServer();
});
afterAll(async () => {
  await server.close();
});

const SCRIPT = {
  steps: {
    // The mock script counts calls per step text, so each row gets its own search text.
    'Search for "t-shirt" and open the "Classic Tee" product for Blue': ['[searchbox] Search products', '[button] Search', '[link] Classic Tee'],
    'Search for "t-shirt" and open the "Classic Tee" product for Black': ['[searchbox] Search products', '[button] Search', '[link] Classic Tee'],
    'Choose colour Blue and size M, then add to cart': ['[radio] Blue', '[radio] M', '[button] Add to cart'],
    'Choose colour Black and size L, then add to cart': ['[radio] Black', '[radio] L', '[button] Add to cart'],
  },
  inputs: { search: 'search_term' },
  expected: 0.95,
};

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 's1p-params-'));
  const s1 = join(root, '.s1pilot');
  mkdirSync(join(s1, 'flows'), { recursive: true });
  mkdirSync(join(s1, 'data'), { recursive: true });
  writeFileSync(
    join(s1, 'project.yaml'),
    `key: SHOP\nname: Shop\ndefaultEnvironment: local\nenvironments:\n  - name: local\n    baseUrl: ${server.url}/shop\n    variables:\n      - { key: search_term, value: t-shirt }\n`,
  );
  writeFileSync(join(s1, 'flows', 'clear-cart.yaml'), 'steps:\n  - action: Make sure the cart is empty\n');
  writeFileSync(
    join(s1, 'flows', 'broken.yaml'),
    'steps:\n  - action: Reach a page that does not exist\n    assert:\n      - { type: urlMatches, pattern: "/nowhere" }\n',
  );
  writeFileSync(join(s1, 'data', 'variants.csv'), 'colour,size\nBlue,M\nBlack,L\n');
  writeFileSync(join(root, 'script.json'), JSON.stringify(SCRIPT));
  return root;
}

function caseYaml(extra: string): string {
  return `key: SHOP-TC-42
title: Parameterised add to cart
${extra}
steps:
  - action: Search for "t-shirt" and open the "Classic Tee" product for {colour}
    inputs: [search_term]
  - action: Choose colour {colour} and size {size}, then add to cart
`;
}

async function run(root: string, caseFile: string, out: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let code = 0;
  const program = buildProgram({
    stdout: (t) => void stdout.push(t),
    stderr: (t) => void stderr.push(t),
    setExitCode: (c) => void (code = c),
    exitOverride: true,
    env: {},
  });
  await program.parseAsync(['run', caseFile, '--project', root, '--adapter', 'mock', '--mock-script', join(root, 'script.json'), '--out', out], { from: 'user' });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

interface Result {
  verdict: string;
  label?: string;
  steps: { verdict: string; phase?: string; sharedStepId?: string }[];
}
const read = (dir: string, name: string): Result => JSON.parse(readFileSync(join(dir, name, 'result.json'), 'utf8')) as Result;

describe('s1pilot run: parameters and shared steps', () => {
  it('runs one result per parameter row, with the clear-cart precondition first', async () => {
    const root = makeProject();
    const file = join(root, 'tc.yaml');
    writeFileSync(file, caseYaml('preconditions:\n  - flow: clear-cart\nparameters:\n  - { colour: Blue, size: M }\n  - { colour: Black, size: L }'));
    const out = join(root, 'res');
    const r = await run(root, file, out);
    expect(r.stderr).toBe('');
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain('[Blue / M]');
    expect(r.stdout).toContain('[Black / L]');
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as { cases: { label: string; verdict: string }[] };
    expect(summary.cases.map((c) => [c.label, c.verdict])).toEqual([
      ['Blue / M', 'passed'],
      ['Black / L', 'passed'],
    ]);
    const first = read(out, 'SHOP-TC-42-1');
    expect(first.steps[0]).toMatchObject({ phase: 'precondition', sharedStepId: 'clear-cart' });
    expect(first.steps).toHaveLength(3);
    const trace = readFileSync(join(out, 'SHOP-TC-42-1', 'trace.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { kind: string; stepIndex: number; sharedStepId?: string });
    expect(trace.find((l) => l.kind === 'step.started' && l.stepIndex === 0)?.sharedStepId).toBe('clear-cart');
  });

  it('expands a dataset reference from .s1pilot/data', async () => {
    const root = makeProject();
    const file = join(root, 'tc.yaml');
    writeFileSync(file, caseYaml('parameters:\n  - { dataset: variants.csv }'));
    const out = join(root, 'res');
    const r = await run(root, file, out);
    expect(r.code, r.stdout).toBe(0);
    expect(read(out, 'SHOP-TC-42-2').steps.map((s) => s.verdict)).toEqual(['passed', 'passed']);
  });

  it('marks the case blocked (not failed) when a flow precondition fails', async () => {
    const root = makeProject();
    const file = join(root, 'tc.yaml');
    writeFileSync(file, caseYaml('preconditions:\n  - flow: broken\nparameters:\n  - { colour: Blue, size: M }'));
    const out = join(root, 'res');
    const r = await run(root, file, out);
    expect(r.code).toBe(1);
    const result = read(out, 'SHOP-TC-42');
    expect(result.verdict).toBe('blocked');
    expect(result.steps.map((s) => s.verdict)).toEqual(['failed', 'skipped', 'skipped']);
    expect(r.stdout).toContain('1 blocked');
  });

  it('reports an unknown flow as a configuration error', async () => {
    const root = makeProject();
    const file = join(root, 'tc.yaml');
    writeFileSync(file, caseYaml('preconditions:\n  - flow: ghost'));
    const r = await run(root, file, join(root, 'res'));
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('"ghost" not found');
  });
});
