import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  computeMetrics,
  formatLeaderboard,
  loadSuite,
  percentile,
  resolveSuiteFile,
  runEval,
  type EvalRunRecord,
  type EvalSummary,
} from './eval.js';
import { buildProgram } from './program.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function rec(over: Partial<EvalRunRecord>): EvalRunRecord {
  return {
    model: 'm',
    profile: null,
    engineSha: 'abc',
    case: 'C',
    bugs: [],
    variants: [],
    repeat: 1,
    phase: 'explore',
    expected: 'passed',
    verdict: 'passed',
    correct: true,
    expectHealing: false,
    healed: false,
    stepsExecuted: 4,
    stepsPassed: 4,
    replayedSteps: 0,
    replayStepsExecuted: 4,
    latenciesMs: [],
    escalations: 0,
    dir: 'x',
    ...over,
  };
}

describe('metrics', () => {
  it('computes percentiles by nearest rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });

  it('counts detection, false-pass, false-fail, needs-review, heal and replay hits; ignores learn runs', () => {
    const m = computeMetrics([
      rec({ phase: 'learn', verdict: 'failed', stepsPassed: 0 }),
      rec({ bugs: ['b'], expected: 'failed', verdict: 'failed', stepsPassed: 2, latenciesMs: [100, 300], escalations: 1 }),
      rec({ bugs: ['b'], expected: 'failed', verdict: 'passed' }),
      rec({ verdict: 'failed', stepsPassed: 3 }),
      rec({ verdict: 'needs-review' }),
      rec({ phase: 'replay', expectHealing: true, variants: ['v'], healed: true, replayedSteps: 3 }),
      rec({ phase: 'replay', expectHealing: true, variants: ['v'], verdict: 'failed', replayedSteps: 1 }),
    ]);
    expect(m.runs).toBe(6);
    expect(m.bugDetectionRate).toBe(0.5);
    expect(m.falsePassRate).toBe(0.5);
    // shouldPass = 4 runs (clean explore failed, healing replay failed)
    expect(m.falseFailRate).toBe(2 / 4);
    expect(m.needsReviewRate).toBeCloseTo(1 / 6);
    expect(m.healSuccessRate).toBe(0.5);
    expect(m.replayHitRate).toBe(0.5);
    expect(m.latencyP50Ms).toBe(100);
    expect(m.latencyP95Ms).toBe(300);
    expect(m.escalations).toBe(1);
  });

  it('reports null for metrics without applicable runs', () => {
    const m = computeMetrics([rec({})]);
    expect(m.bugDetectionRate).toBeNull();
    expect(m.falsePassRate).toBeNull();
    expect(m.healSuccessRate).toBeNull();
  });

  it('lists every metric, the model and engine sha in the leaderboard', () => {
    const summary: EvalSummary = {
      version: 1,
      suite: 's',
      mode: 'oracle',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      repeat: 1,
      engine: { gitSha: 'abc1234' },
      models: [{ id: 'clef-flash', profile: 'clef-flash', adapter: 'systemone', metrics: computeMetrics([rec({})]) }],
      runs: [],
    };
    const md = formatLeaderboard(summary);
    for (const col of ['Step success', 'Bug detection', 'False-fail', 'False-pass', 'Needs-review', 'Heal success', 'Replay hit', 'Latency p50', 'Latency p95', 'Escalations']) {
      expect(md).toContain(col);
    }
    expect(md).toContain('| clef-flash | clef-flash |');
    expect(md).toContain('abc1234');
  });
});

describe('suite loading', () => {
  it('finds suites/fixtures-all from the repo and validates it', () => {
    const file = resolveSuiteFile('fixtures-all', join(repoRoot, 'apps', 'cli'));
    const { suite } = loadSuite(file);
    expect(suite.name).toBe('fixtures-all');
    expect(suite.runs.some((r) => r.bugs.length > 0 && r.verdict === 'failed')).toBe(true);
  });

  it('rejects unknown suites', () => {
    expect(() => resolveSuiteFile('nope', repoRoot)).toThrow(/not found/);
  });
});

describe('s1pilot eval (oracle mode, fixture shop)', () => {
  let server: FixtureServer;
  beforeAll(async () => {
    server = await startFixtureServer();
  });
  afterAll(async () => {
    await server.close();
  });

  it('detects every seeded bug with no false-pass and writes summary + leaderboard', async () => {
    const out = mkdtempSync(join(tmpdir(), 's1p-eval-out-'));
    const { summary, dir } = await runEval(
      { suite: 'fixtures-all', oracle: true, repeat: 1, out, baseUrl: server.url },
      { stdout: () => undefined, stderr: () => undefined, env: {}, gitSha: () => 'deadbee' },
      repoRoot,
    );
    const model = summary.models[0];
    expect(model?.id).toBe('oracle');
    expect(model?.metrics.bugDetectionRate).toBe(1);
    expect(model?.metrics.falsePassRate).toBe(0);
    expect(model?.metrics.falseFailRate).toBe(0);
    expect(summary.runs.every((r) => r.engineSha === 'deadbee' && r.model === 'oracle')).toBe(true);
    expect(summary.runs.filter((r) => r.phase !== 'learn').every((r) => r.correct)).toBe(true);

    const onDisk = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')) as EvalSummary;
    expect(onDisk.engine.gitSha).toBe('deadbee');
    expect(readFileSync(join(dir, 'leaderboard.md'), 'utf8')).toContain('| oracle |');
  });

  it('is registered as a CLI command', () => {
    const program = buildProgram({ exitOverride: true });
    const eval_ = program.commands.find((c) => c.name() === 'eval');
    expect(eval_?.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--suite', '--models', '--repeat', '--oracle', '--out']));
  });

  it('reports a config error without a model', async () => {
    let code = -1;
    const lines: string[] = [];
    await buildProgram({ stdout: () => undefined, stderr: (t) => lines.push(t), setExitCode: (c) => (code = c) }).parseAsync(
      ['eval', '--suite', join(repoRoot, 'suites', 'fixtures-all')],
      { from: 'user' },
    );
    expect(code).toBe(3);
    expect(lines.join('')).toMatch(/--models/);
  });
});
