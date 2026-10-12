import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRedactor, type DecisionRecord, type Question, type RunEvent } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, type MockResolver } from '@s1pilot/providers';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { HumanHook } from '../decide/human.js';
import { createJsonlTraceWriter, createMemoryTraceWriter, TraceLineSchema, type TraceLine } from '../trace/index.js';

import { exploreStep } from './explore-step.js';
import { MOCK_CAPS_FOR_TESTS, makeVars, scriptedS1 } from './test-support.js';
import type { EngineContext } from './types.js';

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
  email: { value: 'demo@example.com' },
  customer_password: { value: PASSWORD, secret: true },
});

async function fresh(path: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.url}${path}`);
  return page;
}

function makeCtx(page: Page, s1: MockDecisionModel, over: Partial<EngineContext> = {}) {
  const events: RunEvent[] = [];
  const trace = createMemoryTraceWriter();
  const ctx: EngineContext = {
    page,
    s1,
    vars,
    params: { colour: 'Blue', size: 'M' },
    environment: { requireApprovalFor: ['pay', 'delete', 'send'] },
    thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 },
    caps: MOCK_CAPS_FOR_TESTS,
    redactor: createRedactor({ secrets: vars.secretValues(), patterns: [] }),
    emit: (e) => events.push(e),
    trace,
    budgets: {},
    runId: 'run1',
    caseResultId: 'cr1',
    ...over,
  };
  return { ctx, events, trace };
}

describe('exploreStep: plan 1.2 case on /shop', () => {
  it('completes the 4 steps with a scripted mock', async () => {
    const page = await fresh('/shop');
    const s1 = new MockDecisionModel({
      fallback: scriptedS1({
        'Search for "t-shirt" and open the "Classic Tee" product': [
          '[searchbox] Search products',
          '[button] Search',
          '[link] Classic Tee',
        ],
        'Choose colour Blue and size M, then add to cart': ['[radio] Blue', '[radio] M', '[button] Add to cart'],
        'Go to checkout as guest and fill the shipping form': [
          '[link] Cart 1',
          '[link] Checkout',
          '[button] Guest checkout',
          '[textbox] Full name',
          '[textbox] ZIP code',
          '[button] Continue to payment',
        ],
        'Stop before payment': [],
      }),
    });
    const { ctx, events, trace } = makeCtx(page, s1);
    const steps = [
      { action: 'Search for "t-shirt" and open the "Classic Tee" product' },
      { action: 'Choose colour {colour} and size {size}, then add to cart' },
      { action: 'Go to checkout as guest and fill the shipping form', inputs: ['shipping_name', 'shipping_zip'] },
      { action: 'Stop before payment', guards: ['block submit_payment'] },
    ];
    const results = [];
    for (const [index, s] of steps.entries()) results.push(await exploreStep(ctx, { index, ...s }));

    expect(results.map((r) => [r.status, r.ended])).toEqual([
      ['passed', 'step_done'],
      ['passed', 'step_done'],
      ['passed', 'step_done'],
      ['passed', 'step_done'],
    ]);
    expect(page.url()).toContain('/shop/checkout/payment');
    expect(await page.evaluate(() => (window as unknown as { fxCart: { read(): unknown[] } }).fxCart.read().length)).toBe(1);

    // Every trace line validates; the event stream is well ordered per step.
    for (const line of trace.lines) expect(() => TraceLineSchema.parse(line)).not.toThrow();
    for (let i = 0; i < steps.length; i++) {
      const types = events.filter((e) => 'stepIndex' in e && e.stepIndex === i).map((e) => e.type);
      expect(types[0]).toBe('step.started');
      expect(types[types.length - 1]).toBe('step.finished');
      expect(types.filter((t) => t === 'decision.made').length).toBeGreaterThan(0);
      expect(types.slice(1, -1).every((t) => t === 'decision.made' || t === 'observation.elements')).toBe(true);
    }
    // No action failed along the way.
    expect(results[2]?.actions.map((a) => a.ok)).not.toContain(false);
  });
});

describe('exploreStep: guards and gating', () => {
  async function trackPayments(page: Page): Promise<string[]> {
    const posts: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'POST') posts.push(req.url());
    });
    return posts;
  }

  it('never executes a payment submit blocked by a step guard', async () => {
    const page = await fresh('/shop/checkout/payment');
    const posts = await trackPayments(page);
    const s1 = new MockDecisionModel({ fallback: scriptedS1({ 'Stop before payment': ['[button] Pay now'] }) });
    const { ctx, events, trace } = makeCtx(page, s1);
    const result = await exploreStep(ctx, { index: 0, action: 'Stop before payment', guards: ['block submit_payment'] });
    expect(result).toMatchObject({ status: 'blocked', ended: 'guard', actions: [] });
    expect(posts).toEqual([]);
    expect(page.url()).toContain('/checkout/payment');
    expect(events.map((e) => e.type)).toEqual(['step.started', 'decision.made', 'decision.made', 'observation.elements', 'decision.made', 'log', 'step.finished']);
    const iteration = trace.lines.find((l) => l.kind === 'iteration');
    expect(iteration).toMatchObject({ sensitive: { classification: 'pay', blocked: true } });
  });

  it('blocks an unguarded payment in an unattended run (sensitive action needs approval)', async () => {
    const page = await fresh('/shop/checkout/payment');
    const posts = await trackPayments(page);
    const s1 = new MockDecisionModel({ fallback: scriptedS1({ 'Pay for the order': ['[button] Pay now'] }) });
    const { ctx } = makeCtx(page, s1);
    const result = await exploreStep(ctx, { index: 0, action: 'Pay for the order' });
    expect(result).toMatchObject({ status: 'blocked', ended: 'sensitive' });
    expect(posts).toEqual([]);
  });

  it('asks an attended human before a sensitive action and emits escalation events', async () => {
    const page = await fresh('/shop/checkout/payment');
    const asked: string[] = [];
    const human: HumanHook = {
      async ask(req) {
        asked.push(req.reason);
        return { skip: true };
      },
    };
    const s1 = new MockDecisionModel({ fallback: scriptedS1({ 'Pay for the order': ['[button] Pay now'] }) });
    const { ctx, events } = makeCtx(page, s1, { human });
    const result = await exploreStep(ctx, { index: 0, action: 'Pay for the order' });
    expect(result).toMatchObject({ status: 'skipped', ended: 'skipped' });
    expect(asked[0]).toMatch(/sensitive action \(pay\)/);
    expect(events.map((e) => e.type)).toContain('escalation.needed');
    expect(events.find((e) => e.type === 'escalation.resolved')).toMatchObject({ resolution: 'skipped' });
    expect(page.url()).toContain('/checkout/payment');
  });

  it('surfaces an attended input question as an escalation', async () => {
    const page = await fresh('/shop');
    const asked: string[] = [];
    const human: HumanHook = {
      async ask(req) {
        asked.push(req.question);
        return { choice: 'mug' };
      },
    };
    const s1 = new MockDecisionModel({ fallback: scriptedS1({ 'Search the catalogue': ['[searchbox] Search products'] }) });
    const { ctx, events } = makeCtx(page, s1, { human });
    const result = await exploreStep(ctx, { index: 0, action: 'Search the catalogue', inputs: ['no_such_key'] });
    expect(result).toMatchObject({ status: 'passed' });
    expect(asked[0]).toMatch(/What should be typed/);
    expect(events.find((e) => e.type === 'escalation.needed')).toMatchObject({ question: expect.stringMatching(/What should be typed/) });
    expect(await page.getByRole('searchbox', { name: 'Search products' }).inputValue()).toBe('mug');
  });

    it('ends blocked when the model says progress is blocked', async () => {
    const page = await fresh('/shop');
    const s1 = new MockDecisionModel({
      fallback: (q: Question, _s, id) =>
        q.type === 'noul' ? { noul: id === 'blocked' ? 0.95 : 0.05 } : { choice: Object.keys(q.criteria)[0] as string },
    });
    const { ctx } = makeCtx(page, s1);
    expect(await exploreStep(ctx, { index: 0, action: 'Do something' })).toMatchObject({
      status: 'blocked',
      ended: 'blocked',
      actions: [],
    });
  });
});

describe('exploreStep: budgets and loop termination', () => {
  const clickApplyForever: MockResolver = (q, _s, id) => {
    if (q.type === 'noul') return { noul: 0.05 };
    if (id !== 'next_action') return { choice: Object.keys(q.criteria)[0] as string };
    return { choice: Object.entries(q.criteria).find(([, d]) => d === '[button] Apply code')?.[0] as string };
  };

  it('stops with a stuck verdict when the same state and action repeat 3 times', async () => {
    const page = await fresh('/shop/cart');
    const { ctx } = makeCtx(page, new MockDecisionModel({ fallback: clickApplyForever }));
    const result = await exploreStep(ctx, { index: 0, action: 'Find something' });
    expect(result).toMatchObject({ status: 'blocked', ended: 'stuck' });
    expect(result.actions).toHaveLength(2);
  });

  it('stops at the per-step action budget', async () => {
    const page = await fresh('/shop');
    let n = 0;
    // Alternates scroll directions so the fingerprint/action pair never repeats 3 times in a row.
    const alternate: MockResolver = (q) => {
      if (q.type === 'noul') return { noul: 0.05 };
      const want = n++ % 2 === 0 ? 'Scroll the page down' : 'Scroll the page up';
      return { choice: Object.entries(q.criteria).find(([, d]) => d === want)?.[0] ?? (Object.keys(q.criteria)[0] as string) };
    };
    const { ctx } = makeCtx(page, new MockDecisionModel({ fallback: alternate }), { budgets: { maxStepsPerCaseStep: 4 } });
    const result = await exploreStep(ctx, { index: 0, action: 'Wander' });
    expect(result).toMatchObject({ status: 'failed', ended: 'budget' });
    expect(result.actions).toHaveLength(4);
  });

  it('stops at the wall-clock budget', async () => {
    const page = await fresh('/shop/cart');
    let now = 0;
    const { ctx } = makeCtx(page, new MockDecisionModel({ fallback: clickApplyForever }), {
      budgets: { maxWallClockMs: 1000, now: () => (now += 600) },
    });
    const result = await exploreStep(ctx, { index: 0, action: 'Find something' });
    expect(result).toMatchObject({ status: 'failed', ended: 'budget' });
  });

  it('fails (does not throw) when the model call throws', async () => {
    const page = await fresh('/shop');
    const s1 = new MockDecisionModel({
      fallback: () => {
        throw new Error('model down');
      },
    });
    const { ctx } = makeCtx(page, s1);
    expect(await exploreStep(ctx, { index: 0, action: 'x' })).toMatchObject({ status: 'failed', ended: 'error' });
  });
});

describe('exploreStep: secrets', () => {
  it('logs in with a secret without leaking it to traces, events or models', async () => {
    const page = await fresh('/shop/login');
    const dir = await mkdtemp(join(tmpdir(), 's1p-trace-'));
    const file = join(dir, 'trace.jsonl');
    const writer = createJsonlTraceWriter(file);
    const s1 = new MockDecisionModel({
      fallback: scriptedS1({
        'Log in with the demo account': ['[textbox] Email', '[textbox] Password', '[button] Log in'],
      }),
    });
    const { ctx, events } = makeCtx(page, s1, { trace: writer });
    const result = await exploreStep(ctx, { index: 0, action: 'Log in with the demo account' });
    await writer.close?.();

    expect(result).toMatchObject({ status: 'passed', ended: 'step_done' });
    expect(await page.getByText('Signed in as').count()).toBeGreaterThan(0);
    expect(result.actions.map((a) => a.valueRef)).toContain('secret:customer_password');

    const raw = await readFile(file, 'utf8');
    const lines = raw.trim().split('\n').map((l) => TraceLineSchema.parse(JSON.parse(l)) as TraceLine);
    expect(lines[0]?.kind).toBe('step.started');
    expect(lines[lines.length - 1]?.kind).toBe('step.finished');
    const everything = [raw, JSON.stringify(events), JSON.stringify(result), JSON.stringify(s1.calls)].join('\n');
    expect(everything).not.toContain(PASSWORD);
    expect(raw).not.toContain('demo@example.com');
    const decisions = lines.flatMap((l) => (l.kind === 'iteration' ? l.decisions : [])) as DecisionRecord[];
    expect(decisions.length).toBeGreaterThan(0);
  });
});
