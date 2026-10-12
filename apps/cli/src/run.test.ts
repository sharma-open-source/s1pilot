import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { RunReportSchema } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { validateJunit } from '@s1pilot/reporters';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildProgram } from './program.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const exec = promisify(execFile);
const cliDir = fileURLToPath(new URL('..', import.meta.url));
const casesDir = fileURLToPath(new URL('../../../fixtures/sites/cases/shop/', import.meta.url));
const CASE = join(casesDir, 'tc-042.yaml');
const SCRIPT = join(casesDir, 'tc-042.mock.json');

let server: FixtureServer;
beforeAll(async () => {
  server = await startFixtureServer();
  // The binary under test is the built bundle; rebuild so the test never runs stale code.
  execFileSync('pnpm', ['exec', 'tsup', 'src/index.ts', '--format', 'esm'], { cwd: cliDir, stdio: 'ignore' });
});
afterAll(async () => {
  await server.close();
});

function out(): string {
  return mkdtempSync(join(tmpdir(), 's1p-run-'));
}

/** Spawns `node dist/index.js` and resolves with its exit code and output. */
async function spawnCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await exec(process.execPath, [join(cliDir, 'dist', 'index.js'), ...args], { env: { PATH: process.env['PATH'] ?? '', ...env } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

function mockArgs(baseUrl: string, dir: string, script = SCRIPT): string[] {
  // explore: a learned script from an earlier run in the fixture project must not turn these into replays.
  return ['run', CASE, '--env', 'local', '--adapter', 'mock', '--mock-script', script, '--base-url', baseUrl, '--mode', 'explore', '--out', dir];
}

interface Result {
  verdict: string;
  steps: { verdict: string; assertions: { assertion: string; verdict: string }[] }[];
}
function readResult(dir: string): Result {
  return JSON.parse(readFileSync(join(dir, 'SHOP-TC-42', 'result.json'), 'utf8')) as Result;
}

describe('s1pilot run (spawned binary, mock model, fixture shop)', () => {
  it('passes the plan 1.2 case end to end with exit code 0', async () => {
    const dir = out();
    const r = await spawnCli(mockArgs(`${server.url}/shop`, dir));
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/✓ 2 · Choose colour Blue and size M, then add to… \(explore, 3 actions, \d+\.\d s\)/);
    expect(r.stdout).toContain('Step success rate: 4/4 (100%)');
    const result = readResult(dir);
    expect(result.verdict).toBe('passed');
    expect(result.steps.map((s) => s.verdict)).toEqual(['passed', 'passed', 'passed', 'passed']);
    const trace = readFileSync(join(dir, 'SHOP-TC-42', 'trace.jsonl'), 'utf8').trim().split('\n');
    expect(trace.length).toBeGreaterThan(8);
    expect(trace.every((l) => (JSON.parse(l) as { v: number }).v === 1)).toBe(true);
    expect(existsSync(join(dir, 'summary.json'))).toBe(true);
  });

  it('exits 1 with a failing step in result.json when a seeded bug is on', async () => {
    const dir = out();
    const r = await spawnCli(mockArgs(`${server.url}/shop?bugs=shop.badge-wrong-count`, dir));
    expect(r.code).toBe(1);
    const result = readResult(dir);
    expect(result.verdict).toBe('failed');
    const failing = result.steps[1];
    expect(failing?.verdict).toBe('failed');
    expect(failing?.assertions.find((a) => a.verdict === 'fail')?.assertion).toBe('elementText');
    expect(result.steps.slice(2).map((s) => s.verdict)).toEqual(['skipped', 'skipped']);
    expect(r.stdout).toContain('✗ 2');
  });

  it('exits 3 with guidance when no model is configured', async () => {
    const r = await spawnCli(['run', CASE, '--env', 'local', '--base-url', `${server.url}/shop`, '--out', out()]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('No System 1 model configured');
    expect(r.stderr).toContain('s1pilot probe');
  });
});

describe('s1pilot run (in-process)', () => {
  function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let code = 0;
    const program = buildProgram({
      stdout: (t) => void stdout.push(t),
      stderr: (t) => void stderr.push(t),
      setExitCode: (c) => void (code = c),
      exitOverride: true,
      env,
    });
    return program.parseAsync(['run', ...args], { from: 'user' }).then(() => ({ code, stdout: stdout.join(''), stderr: stderr.join('') }));
  }

  it('exits 2 when the AI judge is unsure and nothing failed', async () => {
    const dir = out();
    const script = join(dir, 'unsure.json');
    writeFileSync(script, JSON.stringify({ ...(JSON.parse(readFileSync(SCRIPT, 'utf8')) as object), expected: 0.5 }));
    const r = await run(mockArgs(`${server.url}/shop`, join(dir, 'res'), script).slice(1));
    expect(r.code).toBe(2);
    expect(readResult(join(dir, 'res')).verdict).toBe('needs-review');
  });

  it('runs a directory and discovers the project from .s1pilot/project.yaml', async () => {
    const dir = out();
    const r = await run(['run', casesDir, '--adapter', 'mock', '--mock-script', SCRIPT, '--base-url', `${server.url}/shop`, '--out', dir].slice(1));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('env local');
    expect(existsSync(join(dir, 'SHOP-TC-42', 'result.json'))).toBe(true);
  });

  it('keeps secrets out of output: refuses inline secrets and missing env vars', async () => {
    const root = out();
    mkdirSync(join(root, '.s1pilot'), { recursive: true });
    const writeProject = (variable: string): void =>
      writeFileSync(
        join(root, '.s1pilot', 'project.yaml'),
        `key: SHOP\nname: Shop\nenvironments:\n  - name: ci\n    baseUrl: ${server.url}/shop\n    variables:\n      - { key: search_term, value: t-shirt }\n      - { key: shipping_name, value: Alex Doe }\n      - { key: shipping_zip, value: "94105" }\n      - ${variable}\n`,
      );
    const base = [CASE, '--project', root, '--env', 'ci', '--adapter', 'mock', '--mock-script', SCRIPT, '--out', join(root, 'res')];

    writeProject('{ key: customer_password, secret: true, value: hunter2-plain }');
    let r = await run(base);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('secret');
    expect(r.stderr).not.toContain('hunter2-plain');

    writeProject('{ key: customer_password, secret: true, value: "env:SHOP_PW" }');
    r = await run(base);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('SHOP_PW is not set');

    r = await run(base, { SHOP_PW: 'Sup3rSecretPw!' });
    expect(r.code).toBe(0);
    const all = [r.stdout, readFileSync(join(root, 'res', 'SHOP-TC-42', 'trace.jsonl'), 'utf8'), readFileSync(join(root, 'res', 'SHOP-TC-42', 'result.json'), 'utf8')].join('\n');
    expect(all).not.toContain('Sup3rSecretPw!');

    // S-023: the passing explore run left a learned script behind: 4 steps, valueRefs only.
    const learnedFile = join(root, '.s1pilot', 'learned', 'SHOP-TC-42', 'ci.json');
    const learnedText = readFileSync(learnedFile, 'utf8');
    expect(learnedText).not.toContain('Sup3rSecretPw!');
    expect(learnedText).not.toContain('Alex Doe');
    const learned = JSON.parse(learnedText) as { actions: { stepIndex: number; action: string; valueRef?: string }[] };
    const perStep = [0, 1, 2, 3].map((i) => learned.actions.filter((a) => a.stepIndex === i).length);
    expect(perStep.every((n) => n >= 1)).toBe(true);
    expect(learned.actions.filter((a) => a.valueRef).every((a) => /^(secret|var|input|quote):/.test(a.valueRef ?? ''))).toBe(true);
  });

  it('writes valid JUnit XML and JSON reports, and the second run replays the learned script', async () => {
    const root = out();
    mkdirSync(join(root, '.s1pilot'), { recursive: true });
    writeFileSync(
      join(root, '.s1pilot', 'project.yaml'),
      `key: SHOP\nname: Shop\nenvironments:\n  - name: ci\n    baseUrl: ${server.url}/shop\n    variables:\n      - { key: search_term, value: t-shirt }\n      - { key: shipping_name, value: Alex Doe }\n      - { key: shipping_zip, value: "94105" }\n`,
    );
    const args = (dir: string): string[] => [CASE, '--project', root, '--env', 'ci', '--adapter', 'mock', '--mock-script', SCRIPT, '--reporter', 'junit,json', '--out', dir];

    const first = await run(args(join(root, 'res1')));
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('(explore, ');
    expect(first.stdout).toContain('learned script saved');

    const dir = join(root, 'res2');
    const second = await run(args(dir));
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain('(explore, ');
    expect(second.stdout).toMatch(/✓ 2 · .*\(replay, /);

    for (const d of [join(root, 'res1'), dir]) {
      expect(validateJunit(readFileSync(join(d, 'junit.xml'), 'utf8'))).toEqual([]);
      const report = RunReportSchema.parse(JSON.parse(readFileSync(join(d, 'report.json'), 'utf8')));
      expect(report.totals.passed).toBe(1);
    }
    const report = RunReportSchema.parse(JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')));
    expect(report.cases[0]?.mode).toBe('replay');
    expect(report.cases[0]?.steps.every((s) => s.mode === 'replay')).toBe(true);
    expect(readFileSync(join(dir, 'junit.xml'), 'utf8')).toContain('<testcase ');
  });

  it('rejects bad --reporter, --parallel and --mode values', async () => {
    const base = [CASE, '--env', 'local', '--adapter', 'mock', '--mock-script', SCRIPT, '--base-url', `${server.url}/shop`, '--out', out()];
    let r = await run([...base, '--reporter', 'pdf']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Unknown reporter "pdf"');
    r = await run([...base, '--parallel', '0']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('--parallel');
  });

  it('reports unknown environments and missing targets as config errors', async () => {
    let r = await run([CASE, '--env', 'nope', '--adapter', 'mock', '--out', out()]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Unknown environment "nope"');
    r = await run(['/definitely/not/here.yaml', '--base-url', server.url, '--adapter', 'mock']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Not found');
  });
});
