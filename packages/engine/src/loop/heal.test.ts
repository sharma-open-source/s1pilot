import { createRedactor, type LearnedScript } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel } from '@s1pilot/providers';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LearnedRecorder, buildLearnedScript, staleSteps } from '../learned/recorder.js';
import { createMemoryTraceWriter } from '../trace/index.js';

import { exploreStep } from './explore-step.js';
import { replayWithHeal } from './heal.js';
import { MOCK_CAPS_FOR_TESTS, makeVars, scriptedS1 } from './test-support.js';
import type { EngineContext, ExploreStepInput } from './types.js';

vi.setConfig({ testTimeout: 60_000 });

let browser: Browser;
let server: FixtureServer;
let renamed: FixtureServer;
let learned: LearnedScript;
beforeAll(async () => {
  browser = await chromium.launch();
  server = await startFixtureServer();
  renamed = await startFixtureServer({ variant: 'shop.guest-button-renamed' });
  learned = await learnScript();
});
afterAll(async () => {
  await browser.close();
  await server.close();
  await renamed.close();
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
const INPUTS: ExploreStepInput[] = STEPS.map((s, index) => ({ index, ...s }));

function engineCtx(page: Page, plan: Record<string, string[]>, act = 0.8): EngineContext {
  return {
    page,
    s1: new MockDecisionModel({ fallback: scriptedS1(plan) }),
    vars,
    params: {},
    environment: { requireApprovalFor: ['pay', 'delete', 'send'] },
    thresholds: { act, pass: 0.9, fail: 0.1, escalate: 0.4 },
    caps: MOCK_CAPS_FOR_TESTS,
    redactor,
    emit: () => undefined,
    trace: createMemoryTraceWriter(),
    budgets: {},
    runId: 'run2',
    caseResultId: 'cr2',
  };
}

const LEARN_PLAN = {
  'Search for "t-shirt"': ['[searchbox] Search products', '[button] Search', '[link] Classic Tee'],
  'Choose colour Blue': ['[radio] Blue', '[radio] M', '[button] Add to cart'],
  'Go to checkout as guest': ['[link] Cart 1', '[link] Checkout', '[button] Guest checkout', '[textbox] Full name', '[textbox] ZIP code', '[button] Continue to payment'],
  'Stop before payment': [],
};

async function learnScript(): Promise<LearnedScript> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.url}/shop`);
  const recorder = new LearnedRecorder('run1', STEPS);
  const ctx = { ...engineCtx(page, LEARN_PLAN), runId: 'run1', recorder };
  for (const s of INPUTS) expect((await exploreStep(ctx, s)).status).toBe('passed');
  const script = buildLearnedScript({ caseId: 'c1', caseVersion: 1, environmentId: 'e1', runId: 'run1', verdict: 'passed', recorder });
  if (!script) throw new Error('no script learned');
  return script;
}

/** Heal plan: after the break at "Guest checkout" the model picks the renamed button, then fills the form. */
const HEAL_PLAN = {
  'Go to checkout as guest': ['[button] Checkout as guest', '[textbox] Full name', '[textbox] ZIP code', '[button] Continue to payment'],
  'Stop before payment': [],
};

describe('replayWithHeal on variant shop.guest-button-renamed', () => {
  it('heals step 3, passes, and proposes before/after locators without touching the script', async () => {
    const script = learned;
    const snapshot = JSON.stringify(script);
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${renamed.url}/shop`);
    const ctx = engineCtx(page, HEAL_PLAN);
    const result = await replayWithHeal(ctx, { caseId: 'c1', environmentId: 'e1', steps: INPUTS, script });

    expect(result.status).toBe('passed');
    expect(result.steps.map((s) => [s.mode, s.status])).toEqual([
      ['replay', 'passed'],
      ['replay', 'passed'],
      ['healed', 'passed'],
      ['replay', 'passed'],
    ]);
    expect(ctx.page.url()).toContain('/shop/checkout/payment');
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0];
    expect(proposal).toMatchObject({ caseId: 'c1', environmentId: 'e1', stepIndex: 2, runId: 'run2' });
    expect(proposal?.confidence).toBeGreaterThanOrEqual(0.8);

    const guest = (actions: typeof proposal extends undefined ? never : NonNullable<typeof proposal>['before']) =>
      actions.find((a) => a.locators.some((l) => l.name?.toLowerCase().includes('guest')))?.locators[0];
    expect(guest(proposal?.before ?? [])).toMatchObject({ kind: 'role', value: 'button', name: 'Guest checkout' });
    expect(guest(proposal?.after ?? [])).toMatchObject({ kind: 'role', value: 'button', name: 'Checkout as guest' });
    // Unchanged prefix is kept, indices are consecutive and the step hash survives.
    expect(proposal?.after.map((a) => a.subIndex)).toEqual(proposal?.after.map((_, i) => i));
    expect(proposal?.after.slice(0, 2)).toEqual(proposal?.before.slice(0, 2));
    expect(staleSteps({ ...script, actions: proposal?.after ?? [] }, STEPS)).toEqual([]);
    // The learned script is only changed through the repo, after review.
    expect(JSON.stringify(script)).toBe(snapshot);
    // Values never leak into the proposal.
    expect(JSON.stringify(proposal)).not.toContain('Alex Doe');
  });

  it('carries the shared step id onto the proposal', async () => {
    const script = learned;
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${renamed.url}/shop`);
    const steps = INPUTS.map((s) => (s.index === 2 ? { ...s, sharedStepId: 'guest-checkout' } : s));
    const result = await replayWithHeal(engineCtx(page, HEAL_PLAN), { caseId: 'c1', environmentId: 'e1', steps, script });
    expect(result.proposals[0]?.sharedStepId).toBe('guest-checkout');
  });

  it('does not heal below the act threshold: the run fails with no proposal', async () => {
    const script = learned;
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${renamed.url}/shop`);
    const result = await replayWithHeal(engineCtx(page, HEAL_PLAN, 0.999), { caseId: 'c1', environmentId: 'e1', steps: INPUTS, script });
    expect(result.status).not.toBe('passed');
    expect(result.proposals).toEqual([]);
  });

  it('replay-only mode reports the break without healing', async () => {
    const script = learned;
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${renamed.url}/shop`);
    const result = await replayWithHeal(engineCtx(page, HEAL_PLAN), {
      caseId: 'c1', environmentId: 'e1', steps: INPUTS, script, mode: 'replay-only',
    });
    expect(result.status).toBe('failed');
    expect(result.steps[2]).toMatchObject({ mode: 'replay', status: 'failed', replay: { break: { reason: 'locator' } } });
    expect(result.proposals).toEqual([]);
  });

  it('replays an unchanged site with no heal at all', async () => {
    const script = learned;
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${server.url}/shop`);
    const result = await replayWithHeal(engineCtx(page, {}), { caseId: 'c1', environmentId: 'e1', steps: INPUTS, script });
    expect(result.status).toBe('passed');
    expect(result.steps.every((s) => s.mode === 'replay')).toBe(true);
    expect(result.proposals).toEqual([]);
  });
});
