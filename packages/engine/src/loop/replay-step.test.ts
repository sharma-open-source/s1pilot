import { createRedactor, type DecisionModel, type LearnedScript } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel } from '@s1pilot/providers';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LearnedRecorder, buildLearnedScript } from '../learned/recorder.js';
import { fingerprintsMatch, observer, pageFingerprint } from '../observer/index.js';
import { createMemoryTraceWriter } from '../trace/index.js';
import { runAssertion } from '../verify/deterministic.js';

import { exploreStep } from './explore-step.js';
import { actionsForStep, chooseMode, replayStep, type ReplayContext, type ReplayStepResult } from './replay-step.js';
import { MOCK_CAPS_FOR_TESTS, makeVars, scriptedS1 } from './test-support.js';
import type { EngineContext } from './types.js';

vi.setConfig({ testTimeout: 60_000 });

let browser: Browser;
let server: FixtureServer;
beforeAll(async () => {
  browser = await chromium.launch();
  server = await startFixtureServer();
});
afterAll(async () => {
  await browser.close();
  await server.close();
});

const vars = makeVars({
  search_term: { value: 't-shirt' },
  shipping_name: { value: 'Alex Doe' },
  shipping_zip: { value: '94105' },
});
const redactor = createRedactor({ secrets: vars.secretValues(), patterns: [] });

const STEPS = [
  { action: 'Search for "t-shirt" and open the "Classic Tee" product', inputs: ['search_term'] },
  { action: 'Choose colour Blue and size M, then add to cart' },
  { action: 'Go to checkout as guest and fill the shipping form', inputs: ['shipping_name', 'shipping_zip'] },
  { action: 'Stop before payment', guards: ['block submit_payment'] },
];

/** System 1 stand-in with a fixed per-call delay, to model a (fast) network round trip. */
function slow(inner: MockDecisionModel, ms: number): DecisionModel {
  return {
    capabilities: inner.capabilities,
    async decide(req) {
      await new Promise((r) => setTimeout(r, ms));
      return inner.decide(req);
    },
  };
}

/** Explores TC-42 on a fresh page; returns the learned script and the wall time. */
async function exploreTc42(latencyMs = 0): Promise<{ script: LearnedScript; ms: number }> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.url}/shop`);
  const mock = new MockDecisionModel({
    fallback: scriptedS1({
      'Search for "t-shirt"': ['[searchbox] Search products', '[button] Search', '[link] Classic Tee'],
      'Choose colour Blue': ['[radio] Blue', '[radio] M', '[button] Add to cart'],
      'Go to checkout as guest': ['[link] Cart 1', '[link] Checkout', '[button] Guest checkout', '[textbox] Full name', '[textbox] ZIP code', '[button] Continue to payment'],
      'Stop before payment': [],
    }),
  });
  const recorder = new LearnedRecorder('run1', STEPS);
  const ctx: EngineContext = {
    page,
    s1: slow(mock, latencyMs),
    vars,
    params: {},
    environment: { requireApprovalFor: ['pay', 'delete', 'send'] },
    thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 },
    caps: MOCK_CAPS_FOR_TESTS,
    redactor,
    emit: () => undefined,
    trace: createMemoryTraceWriter(),
    budgets: {},
    runId: 'run1',
    caseResultId: 'cr1',
    recorder,
  };
  const t = performance.now();
  for (const [index, s] of STEPS.entries()) {
    const r = await exploreStep(ctx, { index, ...s });
    expect(r.status).toBe('passed');
  }
  const ms = performance.now() - t;
  const script = buildLearnedScript({ caseId: 'c1', caseVersion: 1, environmentId: 'e1', runId: 'run1', verdict: 'passed', recorder });
  if (!script) throw new Error('no script learned');
  return { script, ms };
}

async function replayCase(script: LearnedScript, base: string): Promise<{ results: ReplayStepResult[]; page: Page; ms: number }> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}/shop`);
  const ctx: ReplayContext = { page, vars, params: {}, redactor };
  const results: ReplayStepResult[] = [];
  const t = performance.now();
  for (let i = 0; i < STEPS.length; i++) {
    const r = await replayStep(ctx, i, actionsForStep(script, i));
    results.push(r);
    if (r.status === 'failed') break;
  }
  return { results, page: ctx.page, ms: performance.now() - t };
}

describe('fingerprintsMatch', () => {
  it('matches equal, tolerates small structure drift, rejects other paths and big drift', () => {
    const fp = (path: string, tokens: string[]): string => `${path}.cccccccc.${tokens.join(',')}`;
    const six = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'b0'];
    expect(fingerprintsMatch(fp('p', six), fp('p', six))).toBe(true);
    // 9 of 10 shared: 90%.
    expect(fingerprintsMatch(fp('p', six), fp('p', [...six.slice(0, 9), 'zz']))).toBe(true);
    // 8 of 10 shared: exactly 80%.
    expect(fingerprintsMatch(fp('p', six), fp('p', [...six.slice(0, 8), 'y1', 'y2']))).toBe(true);
    // 7 of 10 shared.
    expect(fingerprintsMatch(fp('p', six), fp('p', [...six.slice(0, 7), 'y1', 'y2', 'y3']))).toBe(false);
    expect(fingerprintsMatch(fp('p', six), fp('q', six))).toBe(false);
    expect(fingerprintsMatch(fp('p', []), fp('p', []))).toBe(true);
    expect(fingerprintsMatch('abcdef0123456789', 'abcdef0123456780')).toBe(false);
  });

  it('treats a renamed button as the same page', async () => {
    const renamed = await startFixtureServer({ variant: 'shop.guest-button-renamed' });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${server.url}/shop/checkout`);
      const a = pageFingerprint(await observer.capture(page));
      await page.goto(`${renamed.url}/shop/checkout`);
      const b = pageFingerprint(await observer.capture(page));
      expect(a).not.toBe(b);
      expect(fingerprintsMatch(a, b)).toBe(true);
    } finally {
      await renamed.close();
    }
  });
});

describe('chooseMode', () => {
  const env = { id: 'e1' };
  it('follows the plan when the script is usable and falls back to explore otherwise', async () => {
    const { script } = await exploreTc42();
    expect(chooseMode({ steps: STEPS }, env, 'replay-heal', script)).toMatchObject({ mode: 'replay-heal', reason: 'script-ok' });
    expect(chooseMode({ steps: STEPS }, env, 'replay-only', script)).toMatchObject({ mode: 'replay-only', blocked: false });
    expect(chooseMode({ steps: STEPS }, env, 'explore', script)).toMatchObject({ mode: 'explore', reason: 'plan-explore' });
    expect(chooseMode({ steps: STEPS }, env)).toMatchObject({ mode: 'explore', reason: 'no-script', blocked: false });
    expect(chooseMode({ steps: STEPS }, env, 'replay-only')).toMatchObject({ mode: 'explore', blocked: true });
    expect(chooseMode({ steps: STEPS }, { id: 'e2' }, 'replay-heal', script)).toMatchObject({ reason: 'environment-mismatch' });
    const edited = STEPS.map((s, i) => (i === 1 ? { ...s, action: 'Choose colour Red and size M, then add to cart' } : s));
    expect(chooseMode({ steps: edited }, env, 'replay-heal', script)).toMatchObject({ mode: 'explore', reason: 'stale-steps', staleSteps: [1] });
    expect(chooseMode({ steps: [...STEPS, { action: 'One more' }] }, env, 'replay-heal', script).reason).toBe('incomplete-script');
  });
});

describe('replayStep: TC-42 on the shop fixture', () => {
  it('replays all 4 steps with no model and deterministic assertions pass', async () => {
    const { script } = await exploreTc42();
    const { results, page } = await replayCase(script, server.url);
    expect(results.map((r) => [r.status, r.mode])).toEqual([
      ['passed', 'replay'],
      ['passed', 'replay'],
      ['passed', 'replay'],
      ['passed', 'replay'],
    ]);
    expect(page.url()).toContain('/shop/checkout/payment');
    const urlCheck = await runAssertion(page, { type: 'urlMatches', pattern: '/checkout/payment' });
    expect(urlCheck.verdict).toBe('pass');
    expect(await page.evaluate(() => (window as unknown as { fxCart: { read(): unknown[] } }).fxCart.read().length)).toBe(1);
    // Values are never part of the result.
    expect(JSON.stringify(results)).not.toContain('Alex Doe');
  });

  it('breaks at step 3 with reason locator on variant shop.guest-button-renamed', async () => {
    const { script } = await exploreTc42();
    const renamed = await startFixtureServer({ variant: 'shop.guest-button-renamed' });
    try {
      const { results } = await replayCase(script, renamed.url);
      expect(results.map((r) => r.status)).toEqual(['passed', 'passed', 'failed']);
      const broken = results[2]?.break;
      expect(broken).toMatchObject({ stepIndex: 2, reason: 'locator' });
      expect(script.actions.find((a) => a.stepIndex === 2 && a.subIndex === broken?.subIndex)?.locators[0]?.name).toBe('Guest checkout');
    } finally {
      await renamed.close();
    }
  });

  it('breaks with reason fingerprint when the page is a different one', async () => {
    const { script } = await exploreTc42();
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${server.url}/shop/checkout/payment`);
    const result = await replayStep({ page, vars, params: {}, redactor }, 1, actionsForStep(script, 1));
    expect(result).toMatchObject({ status: 'failed', break: { stepIndex: 1, subIndex: 0, reason: 'fingerprint' } });
  });

  it('breaks with reason action-error when a value cannot be resolved', async () => {
    const { script } = await exploreTc42();
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${server.url}/shop`);
    const r1 = await replayStep({ page, vars, params: {}, redactor }, 0, actionsForStep(script, 0));
    expect(r1.status).toBe('passed');
    const page2 = await (await browser.newContext()).newPage();
    await page2.goto(`${server.url}/shop`);
    const noVars = { ...vars, get: () => undefined };
    const r2 = await replayStep({ page: page2, vars: noVars, params: {}, redactor }, 0, actionsForStep(script, 0));
    expect(r2).toMatchObject({ status: 'failed', break: { reason: 'action-error' } });
  });
});

describe('replay benchmark', () => {
  it('is much faster than explore on TC-42', async () => {
    // Explore pays a model round trip per question; 40 ms is far below real cloud latency (0.7-1.5 s).
    const { script, ms: exploreMs } = await exploreTc42(40);
    const { results, ms: replayMs } = await replayCase(script, server.url);
    expect(results.every((r) => r.status === 'passed')).toBe(true);
    const ratio = exploreMs / replayMs;
    console.log(`[S-024 bench] explore ${exploreMs.toFixed(0)} ms, replay ${replayMs.toFixed(0)} ms, speedup ${ratio.toFixed(1)}x`);
    console.log(`[S-024 bench] per step replay ${results.map((r) => r.durationMs.toFixed(0)).join('/')} ms`);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });
});
