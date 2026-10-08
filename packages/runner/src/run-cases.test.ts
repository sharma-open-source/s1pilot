import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EnvironmentSchema, createRedactor, newId, type Environment, type LearnedScript, type TestCase } from '@s1pilot/domain';
import type { HealProposalDraft } from '@s1pilot/engine';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, loadMockScript, mockResolver } from '@s1pilot/providers';
import { loadCaseFile, type LearnedScriptRef, type LearnedScriptStore } from '@s1pilot/sync';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCases, type RunnerEvent, type RunCasesInput } from './run-cases.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const casesDir = fileURLToPath(new URL('../../../fixtures/sites/cases/shop/', import.meta.url));
const VALUES: Record<string, string> = { search_term: 't-shirt', shipping_name: 'Alex Doe', shipping_zip: '94105' };

let server: FixtureServer;
let browser: Browser;
beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await server.close();
});

class MemoryScripts implements LearnedScriptStore {
  readonly map = new Map<string, LearnedScript>();
  async get(ref: LearnedScriptRef): Promise<LearnedScript | undefined> {
    return this.map.get(ref.caseKey);
  }
  async put(ref: LearnedScriptRef, script: LearnedScript): Promise<void> {
    this.map.set(ref.caseKey, script);
  }
  async delete(ref: LearnedScriptRef): Promise<void> {
    this.map.delete(ref.caseKey);
  }
}

function environment(): Environment {
  return EnvironmentSchema.parse({ id: newId(), projectId: newId(), name: 'local', baseUrl: `${server.url}/shop` });
}

function setup(env: Environment, out: string, extra: Partial<RunCasesInput> = {}): RunCasesInput {
  const script = loadMockScript(join(casesDir, 'tc-042.mock.json'));
  // Second case of the parallel test; the scripted mock keeps per-step-text state, so its text differs.
  script.steps['Look up "t-shirt" and open Classic Tee'] = ['[searchbox] Search products', '[button] Search', '[link] Classic Tee'];
  const s1 = new MockDecisionModel({ fallback: mockResolver(script) });
  return {
    cases: [loadCaseFile(join(casesDir, 'tc-042.yaml'))],
    environment: env,
    browser,
    browserName: 'chromium',
    models: { s1, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, modelName: 'mock' },
    out,
    vars: {
      keys: () => Object.keys(VALUES),
      isSecret: () => false,
      secretValues: () => [],
      get: (k) => VALUES[k],
    },
    redactor: createRedactor({ secrets: [], patterns: [] }),
    ...extra,
  };
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 's1p-runner-'));

describe('runCases', () => {
  it('explores the first run (learning a script), then replays the second without next_action decisions', async () => {
    const env = environment();
    const scripts = new MemoryScripts();
    const first = await runCases(setup(env, tmp(), { stores: { scripts } }));
    expect(first.cases[0]?.verdict).toBe('passed');
    expect(first.cases[0]?.mode).toBe('explore');
    expect(first.cases[0]?.steps.every((s) => s.mode === 'explore')).toBe(true);
    expect(scripts.map.size).toBe(1);

    const out = tmp();
    const second = await runCases(setup(env, out, { stores: { scripts } }));
    const c = second.cases[0];
    expect(c?.verdict).toBe('passed');
    expect(c?.mode).toBe('replay');
    expect(c?.steps.map((s) => s.mode)).toEqual(['replay', 'replay', 'replay', 'replay']);
    expect(c?.steps.flatMap((s) => s.decisions).some((d) => d.questionId === 'next_action')).toBe(false);
    expect(second.totals.passed).toBe(1);
    expect(existsSync(join(out, 'SHOP-TC-42', 'result.json'))).toBe(true);
    const written = JSON.parse(readFileSync(join(out, 'SHOP-TC-42', 'result.json'), 'utf8')) as { mode: string };
    expect(written.mode).toBe('replay');
  });

  it('heals a broken step, keeps the case passing and hands the proposal to the store', async () => {
    const env = environment();
    const scripts = new MemoryScripts();
    await runCases(setup(env, tmp(), { stores: { scripts } }));
    const learned = [...scripts.map.values()][0] as LearnedScript;
    scripts.map.set('SHOP-TC-42', {
      ...learned,
      actions: learned.actions.map((a) =>
        a.stepIndex === 1 ? { ...a, locators: [{ kind: 'role' as const, value: 'button', name: 'No such control' }] } : a,
      ),
    });
    const proposals: HealProposalDraft[] = [];
    const events: RunnerEvent[] = [];
    const report = await runCases(
      setup(env, tmp(), {
        stores: { scripts, healProposals: { create: async (d) => void proposals.push(d) } },
        emit: (e) => void events.push(e),
      }),
    );
    const c = report.cases[0];
    expect(c?.verdict).toBe('passed');
    expect(c?.mode).toBe('healed');
    expect(c?.steps.map((s) => s.mode)).toEqual(['replay', 'healed', 'replay', 'replay']);
    expect(c?.healProposals).toBe(1);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.stepIndex).toBe(1);
    expect(events.filter((e) => e.type === 'step.finished')).toHaveLength(4);
  });

  it('replay-only never explores: no script means a blocked case', async () => {
    const report = await runCases(setup(environment(), tmp(), { mode: 'replay-only', stores: { scripts: new MemoryScripts() } }));
    expect(report.cases[0]?.verdict).toBe('blocked');
    expect(report.cases[0]?.steps[0]?.reason).toContain('replay-only');
    expect(report.totals.blocked).toBe(1);
  });

  it('explore mode ignores a stored script', async () => {
    const env = environment();
    const scripts = new MemoryScripts();
    await runCases(setup(env, tmp(), { stores: { scripts } }));
    const report = await runCases(setup(env, tmp(), { mode: 'explore', stores: { scripts } }));
    expect(report.cases[0]?.mode).toBe('explore');
  });

  it('runs --parallel 2 cases at the same time in separate browser contexts', async () => {
    const env = environment();
    const base = loadCaseFile(join(casesDir, 'tc-042.yaml'));
    const clone: TestCase = {
      ...base,
      id: newId(),
      key: 'SHOP-TC-43',
      parameters: [],
      steps: [{ ...(base.steps[0] as TestCase['steps'][number]), action: 'Look up "t-shirt" and open Classic Tee' }],
    };
    let running = 0;
    let peak = 0;
    let peakContexts = 0;
    const report = await runCases(
      setup(env, tmp(), {
        cases: [base, clone],
        parallelism: 2,
        emit: (e) => {
          if (e.type === 'case.started') {
            running++;
            peak = Math.max(peak, running);
          }
          if (e.type === 'step.finished') peakContexts = Math.max(peakContexts, browser.contexts().length);
          if (e.type === 'case.finished') running--;
        },
      }),
    );
    expect(report.cases.map((c) => c.verdict)).toEqual(['passed', 'passed']);
    expect(report.cases.map((c) => c.key)).toEqual(['SHOP-TC-42', 'SHOP-TC-43']);
    expect(peak).toBe(2);
    expect(peakContexts).toBeGreaterThanOrEqual(2);
  });
});
