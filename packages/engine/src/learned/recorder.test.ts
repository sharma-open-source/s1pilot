import { createRedactor, type LearnedScript } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel } from '@s1pilot/providers';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { exploreStep } from '../loop/explore-step.js';
import { MOCK_CAPS_FOR_TESTS, makeVars, scriptedS1 } from '../loop/test-support.js';
import type { EngineContext } from '../loop/types.js';
import { createMemoryTraceWriter } from '../trace/index.js';

import { LearnedRecorder, buildLearnedScript, hashStep, invalidateChangedSteps, staleSteps } from './recorder.js';

vi.setConfig({ testTimeout: 30_000 });

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

const PASSWORD = 'password123';
const vars = makeVars({
  search_term: { value: 't-shirt' },
  shipping_name: { value: 'Alex Doe' },
  shipping_zip: { value: '94105' },
  customer_password: { value: PASSWORD, secret: true },
});

const STEPS = [
  { action: 'Search for "t-shirt" and open the "Classic Tee" product', inputs: ['search_term'] },
  { action: 'Choose colour {colour} and size {size}, then add to cart' },
  { action: 'Go to checkout as guest and fill the shipping form', inputs: ['shipping_name', 'shipping_zip'] },
  { action: 'Stop before payment', guards: ['block submit_payment'] },
];

async function exploreTc42(): Promise<{ recorder: LearnedRecorder }> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.url}/shop`);
  const s1 = new MockDecisionModel({
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
    s1,
    vars,
    params: { colour: 'Blue', size: 'M' },
    environment: { requireApprovalFor: ['pay', 'delete', 'send'] },
    thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 },
    caps: MOCK_CAPS_FOR_TESTS,
    redactor: createRedactor({ secrets: vars.secretValues(), patterns: [] }),
    emit: () => undefined,
    trace: createMemoryTraceWriter(),
    budgets: {},
    runId: 'run1',
    caseResultId: 'cr1',
    recorder,
  };
  for (const [index, s] of STEPS.entries()) await exploreStep(ctx, { index, ...s });
  return { recorder };
}

function build(recorder: LearnedRecorder, verdict: 'passed' | 'failed' = 'passed', humanApproved = false): LearnedScript | null {
  return buildLearnedScript({ caseId: 'c1', caseVersion: 1, environmentId: 'e1', runId: 'run1', verdict, recorder, humanApproved });
}

describe('learned script capture (TC-42 on the shop fixture)', () => {
  it('records at least one action per step, with ordered locators and refs only', async () => {
    const { recorder } = await exploreTc42();
    const script = build(recorder);
    expect(script).not.toBeNull();
    const actions = (script as LearnedScript).actions;
    // The last step ("Stop before payment") acts on nothing and is stored as a `wait` no-op.
    for (let i = 0; i < 4; i++) expect(actions.filter((a) => a.stepIndex === i).length).toBeGreaterThanOrEqual(1);
    // subIndex counts up within a step.
    expect(actions.filter((a) => a.stepIndex === 3).map((a) => a.action)).toEqual(['wait']);
    const step0 = actions.filter((a) => a.stepIndex === 0).map((a) => a.subIndex);
    expect(step0).toEqual(step0.map((_, i) => i));
    for (const a of actions) {
      expect(a.fingerprint).toBeTruthy();
      expect(a.postFingerprint).toBeTruthy();
      expect(a.stepHash).toBe(hashStep(STEPS[a.stepIndex] as { action: string }));
      if (['click', 'fill'].includes(a.action)) expect(a.locators.length).toBeGreaterThan(0);
    }
    expect(actions.some((a) => a.waitHint === 'navigation')).toBe(true);
    const fills = actions.filter((a) => a.action === 'fill');
    expect(fills.length).toBeGreaterThan(0);
    expect(fills.every((f) => /^(secret|var|input):/.test(f.valueRef ?? ''))).toBe(true);
    const text = JSON.stringify(script);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('Alex Doe');
    expect(text).not.toContain('94105');
  });

  it('editing step 3 invalidates only step 3 actions', async () => {
    const { recorder } = await exploreTc42();
    const script = build(recorder) as LearnedScript;
    expect(staleSteps(script, STEPS)).toEqual([]);
    const edited = STEPS.map((s, i) => (i === 2 ? { ...s, action: `${s.action}, then continue` } : s));
    const result = invalidateChangedSteps(script, edited, 2);
    expect(result.invalidated).toEqual([2]);
    expect(result.script.caseVersion).toBe(2);
    expect(result.script.actions.filter((a) => a.stepIndex === 2)).toEqual([]);
    for (const i of [0, 1]) {
      expect(result.script.actions.filter((a) => a.stepIndex === i)).toEqual(script.actions.filter((a) => a.stepIndex === i));
    }
    expect(result.script.actions.length).toBe(script.actions.filter((a) => a.stepIndex !== 2).length);
  });
});

describe('buildLearnedScript', () => {
  const entry = {
    stepIndex: 0,
    action: { kind: 'click' as const, locators: [{ kind: 'text' as const, value: 'A' }, { kind: 'css' as const, value: '#a' }] },
    usedLocator: { kind: 'css' as const, value: '#a' },
    preFingerprint: 'p',
    postFingerprint: 'q',
    navigated: false,
  };

  it('only builds for passed or human-approved runs and puts the winning locator first', () => {
    const recorder = new LearnedRecorder('r');
    recorder.record(entry);
    expect(build(recorder, 'failed')).toBeNull();
    const approved = build(recorder, 'failed', true);
    expect(approved?.actions[0]?.locators.map((l) => l.value)).toEqual(['#a', 'A']);
    expect(build(recorder)).not.toBeNull();
    expect(build(new LearnedRecorder('r'))).toBeNull();
  });
});
