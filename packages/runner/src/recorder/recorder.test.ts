import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EnvironmentSchema, TestCaseSchema, createRedactor, newId, stepGuideExamples, type Environment, type LearnedScript, type ResolvedAction } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel } from '@s1pilot/providers';
import type { ChatModel } from '@s1pilot/providers';
import type { LearnedScriptRef, LearnedScriptStore } from '@s1pilot/sync';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCases } from '../run-cases.js';

import { groupTimeline } from './group.js';
import { insertResolved, recordedScript, recordedToResolved } from './learned.js';
import { startRecorder, type RecorderHandle } from './session.js';
import { describeStepsWithModel, stepTemplate } from './text.js';
import type { CapturedAction, TimelineItem } from './types.js';
import { ValueMapper, variableKeyFor } from './values.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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

function environment(path = '/shop'): Environment {
  return EnvironmentSchema.parse({ id: newId(), projectId: newId(), name: 'local', baseUrl: `${server.url}${path}` });
}

const VALUES: Record<string, string> = { search_term: 't-shirt', shipping_name: 'Alex Doe', shipping_zip: '94105' };

function act(partial: Partial<CapturedAction> & { ts: number }): TimelineItem {
  return {
    type: 'action',
    action: {
      id: newId(),
      kind: 'click',
      role: 'button',
      name: 'Go',
      locators: [],
      navigated: false,
      fingerprint: 'a',
      postFingerprint: 'b',
      ...partial,
    },
  };
}

describe('groupTimeline', () => {
  it('splits after a navigation', () => {
    const groups = groupTimeline([act({ ts: 0 }), act({ ts: 100, navigated: true }), act({ ts: 200 })]);
    expect(groups.map((g) => g.actions.length)).toEqual([2, 1]);
  });

  it('splits on a pause longer than 4 s', () => {
    const groups = groupTimeline([act({ ts: 0 }), act({ ts: 3900 }), act({ ts: 8000 })]);
    expect(groups.map((g) => g.actions.length)).toEqual([2, 1]);
  });

  it('closes a step at an expected result and appends one that follows a closed step', () => {
    const groups = groupTimeline([
      act({ ts: 0 }),
      { type: 'expect', text: 'Cart shows 1', ts: 10 },
      act({ ts: 20 }),
      { type: 'expect', text: 'Badge is 1', ts: 30 },
      { type: 'expect', text: 'Price shown', ts: 40 },
    ]);
    expect(groups.map((g) => g.expected)).toEqual(['Cart shows 1', 'Badge is 1; Price shown']);
  });

  it('merges consecutive pass-through navigation clicks', () => {
    const groups = groupTimeline([
      act({ ts: 0, navigated: true, name: 'Cart' }),
      act({ ts: 500, navigated: true, name: 'Checkout' }),
      act({ ts: 900, navigated: true, name: 'Guest' }),
      act({ ts: 1200, kind: 'fill', role: 'textbox', name: 'ZIP', valueRef: 'var:shipping_zip' }),
    ]);
    expect(groups.map((g) => g.actions.length)).toEqual([3, 1]);
  });
});

describe('ValueMapper', () => {
  it('reuses a known variable on an exact match and proposes new ones otherwise', () => {
    const m = new ValueMapper({ vars: { shipping_zip: '94105' }, secretKeys: ['api_token'] });
    expect(m.mapValue('ZIP code', '94105')).toEqual({ valueRef: 'var:shipping_zip', key: 'shipping_zip' });
    expect(m.mapValue('Full name', 'Alex')).toEqual({ valueRef: 'var:full_name', key: 'full_name' });
    expect(m.mapValue('Full name again', 'Alex').valueRef).toBe('var:full_name');
    expect(m.mapValue('Full name', 'Sam').valueRef).toBe('var:full_name_2');
    expect(m.mapSecret('Password')).toEqual({ valueRef: 'secret:password', key: 'password' });
    expect(m.mapSecret('API token').valueRef).toBe('secret:api_token');
    expect(m.proposals().map((p) => [p.key, p.secret, p.value])).toEqual([
      ['full_name', false, 'Alex'],
      ['full_name_2', false, 'Sam'],
      ['password', true, undefined],
    ]);
  });

  it('derives snake_case keys', () => {
    expect(variableKeyFor('Search products')).toBe('search_products');
    expect(variableKeyFor('  ')).toBe('value');
  });
});

describe('System 2 step text', () => {
  const groups = groupTimeline([act({ ts: 0, kind: 'fill', role: 'textbox', name: 'ZIP', valueRef: 'var:shipping_zip' }), act({ ts: 10, name: 'Continue', navigated: true })]);

  it('sends names and value keys only and uses the answer', async () => {
    const chatJson = vi.fn(async () => ({ steps: [{ action: 'Enter the ZIP code and continue', expected: 'Payment step is shown' }] }));
    const chat = { chatJson } as unknown as ChatModel;
    const out = await describeStepsWithModel(chat, groups);
    expect(out).toEqual([{ action: 'Enter the ZIP code and continue', expected: 'Payment step is shown' }]);
    const sent = JSON.stringify(chatJson.mock.calls[0]);
    expect(sent).toContain('shipping_zip');
    // The shared step wording, but values stay test data keys: no "quote every value" rule.
    const system = (chatJson.mock.calls[0] as unknown as [{ system: string }])[0].system;
    expect(system).toContain(stepGuideExamples());
    expect(system).toContain('A wait step starts with "Wait"');
    expect(system).not.toContain('Put every exact value');
    expect(system).toContain('never invent, quote or guess a value');
  });

  it('falls back (null) when the model fails or miscounts', async () => {
    const bad = { chatJson: async () => ({ steps: [] }) } as unknown as ChatModel;
    expect(await describeStepsWithModel(bad, groups)).toBeNull();
    const throwing = {
      chatJson: async () => {
        throw new Error('down');
      },
    } as unknown as ChatModel;
    expect(await describeStepsWithModel(throwing, groups)).toBeNull();
    expect(stepTemplate(groups[0] ?? { actions: [] })).toBe("Fill 'ZIP' with shipping_zip, click 'Continue'");
  });
});

describe('learned script assembly', () => {
  it('inserts recorded actions into an existing script and shifts later steps', () => {
    const base = { locators: [] as ResolvedAction['locators'], fingerprint: 'f', fromRunId: 'r' };
    const existing = [
      { ...base, stepIndex: 0, subIndex: 0, action: 'click' as const },
      { ...base, stepIndex: 1, subIndex: 0, action: 'click' as const },
    ];
    const inserted = [{ ...base, stepIndex: 0, subIndex: 0, action: 'wait' as const }];
    expect(insertResolved(existing, inserted, 1, 1).map((a) => [a.stepIndex, a.action])).toEqual([
      [0, 'click'],
      [1, 'wait'],
      [2, 'click'],
    ]);
  });
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

async function open(env: Environment, extra: Partial<Parameters<typeof startRecorder>[0]> = {}): Promise<RecorderHandle> {
  return startRecorder({
    environment: env,
    launch: async () => chromium.launch(),
   
    known: { vars: VALUES, secretKeys: [] },
    ...extra,
  });
}

async function recordGuestCheckout(rec: RecorderHandle): Promise<void> {
  const p = rec.page;
  await p.getByRole('searchbox', { name: 'Search products' }).fill('t-shirt');
  await p.getByRole('button', { name: 'Search' }).click();
  await p.waitForURL(/search/);
  await p.getByRole('link', { name: 'Classic Tee' }).click();
  await p.waitForURL(/product/);
  await p.getByRole('radio', { name: 'Blue' }).check();
  await p.getByRole('radio', { name: 'M', exact: true }).check();
  await p.getByRole('button', { name: 'Add to cart' }).click();
  await p.getByRole('status', { name: 'Cart items' }).filter({ hasText: '1' }).waitFor();
  await p.getByRole('link', { name: /^Cart/ }).click();
  await p.waitForURL(/cart/);
  await p.getByRole('link', { name: 'Checkout' }).click();
  await p.waitForURL(/checkout/);
  await p.getByRole('button', { name: /guest/i }).click();
  await p.waitForURL(/shipping/);
  await p.getByLabel('Full name').fill('Alex Doe');
  await p.getByLabel('ZIP code').fill('94105');
  await p.getByRole('button', { name: 'Continue to payment' }).click();
  await p.waitForURL(/payment/);
}

describe('recorder (headless Chromium against the shop fixture)', () => {
  it('records the guest checkout into a few steps and a learned script that replays without a model', async () => {
    const env = environment();
    const rec = await open(env);
    await recordGuestCheckout(rec);
    const live = rec.snapshot();
    expect(live.state).toBe('recording');
    expect(live.steps.length).toBeGreaterThan(0);
    const draft = await rec.stop();

    expect(draft.textSource).toBe('template');
    expect(draft.steps.length).toBeGreaterThanOrEqual(4);
    expect(draft.steps.length).toBeLessThanOrEqual(6);
    expect(draft.steps[0]?.action).toBe("Fill 'Search products' with search_term, click 'Search'");
    expect(draft.variables).toEqual([]);
    expect(draft.steps.flatMap((s) => s.inputs)).toEqual(['search_term', 'shipping_name', 'shipping_zip']);
    expect(draft.steps.some((s) => s.action.includes("Click 'Checkout'"))).toBe(true);

    const testCase = TestCaseSchema.parse({
      id: newId(),
      projectId: env.projectId,
      key: 'REC-TC-1',
      title: 'Recorded guest checkout',
      priority: 'P2',
      type: 'e2e',
      status: 'draft',
      steps: draft.steps.map((s) => ({ action: s.action, inputs: s.inputs, assert: [] })),
    });
    const scripts = new MemoryScripts();
    scripts.map.set(
      'REC-TC-1',
      recordedScript({
        caseId: testCase.id,
        caseVersion: testCase.version,
        environmentId: env.id,
        actions: recordedToResolved(draft.steps, newId()),
      }) as LearnedScript,
    );

    let modelCalls = 0;
    const s1 = new MockDecisionModel({ fallback: () => ({}) });
    const guarded = {
      capabilities: s1.capabilities,
      decide: async () => {
        modelCalls++;
        throw new Error('replay must not call the model');
      },
    };
    const report = await runCases({
      cases: [testCase],
      environment: env,
      browser,
      browserName: 'chromium',
      mode: 'replay-only',
      models: { s1: guarded, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, modelName: 'none' },
      stores: { scripts },
      out: mkdtempSync(join(tmpdir(), 's1p-rec-')),
      vars: { keys: () => Object.keys(VALUES), isSecret: () => false, secretValues: () => [], get: (k) => VALUES[k] },
      redactor: createRedactor({ secrets: [], patterns: [] }),
    });
    const c = report.cases[0];
    expect(c?.steps.map((st) => st.mode)).toEqual(draft.steps.map(() => 'replay'));
    expect(c?.verdict).toBe('passed');
    expect(c?.mode).toBe('replay');
    expect(modelCalls).toBe(0);
  });

  it('turns Enter in a field with a submit button into the click that submits', async () => {
    const rec = await open(environment());
    const p = rec.page;
    await p.getByRole('searchbox', { name: 'Search products' }).fill('t-shirt');
    await p.getByRole('searchbox', { name: 'Search products' }).press('Enter');
    await p.waitForURL(/search/);
    const draft = await rec.stop();
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0]?.actions.map((a) => a.kind)).toEqual(['fill', 'click']);
  });

  it('never persists a typed password and proposes a secret variable instead', async () => {
    const PASSWORD = 'hunter2-Very-Secret';
    const rec = await open(environment('/shop/login'), { known: { vars: {}, secretKeys: [] } });
    const p = rec.page;
    await p.getByLabel('Email').fill('alex@example.com');
    await p.getByLabel('Password').fill(PASSWORD);
    await p.getByRole('button', { name: 'Log in' }).click();
    await p.waitForLoadState('load');
    const live = JSON.stringify(rec.snapshot());
    const draft = await rec.stop();

    const everything = JSON.stringify({ draft, live });
    expect(everything).not.toContain(PASSWORD);
    expect(draft.variables).toEqual([
      { key: 'email', value: 'alex@example.com', secret: false, field: 'Email' },
      { key: 'password', secret: true, field: 'Password' },
    ]);
    const refs = draft.steps.flatMap((s) => s.actions.map((a) => a.valueRef));
    expect(refs).toContain('secret:password');
    const script = JSON.stringify(recordedToResolved(draft.steps, newId()));
    expect(script).not.toContain(PASSWORD);
    expect(draft.steps[0]?.action).toContain('Fill');
    expect(draft.steps[0]?.action).not.toContain(PASSWORD);
  });

  it('honours pause/resume, expected results and System 2 step text', async () => {
    const chatJson = vi.fn(async () => ({ steps: [{ action: 'Search for a t-shirt' }] }));
    const rec = await open(environment(), { chat: { chatJson } as unknown as ChatModel });
    const p = rec.page;
    rec.pause();
    await p.getByRole('link', { name: 'Home' }).click();
    await p.waitForLoadState('load');
    expect(rec.snapshot().state).toBe('paused');
    rec.resume();
    await p.getByRole('searchbox', { name: 'Search products' }).fill('t-shirt');
    await p.getByRole('button', { name: 'Search' }).click();
    await p.waitForURL(/search/);
    // Toolbar commands arrive through the same binding the toolbar buttons use.
    await p.evaluate(() => (window as unknown as Record<string, (e: unknown) => Promise<void>>)['__s1pilotRecord']?.({ type: 'expect', text: 'Results are listed', ts: Date.now(), frameUrl: '' }));
    await vi.waitFor(() => expect(rec.snapshot().steps[0]?.expected).toBe('Results are listed'));
    const draft = await rec.stop();
    expect(draft.textSource).toBe('s2');
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0]?.action).toBe('Search for a t-shirt');
    expect(draft.steps[0]?.expected).toBe('Results are listed');
    expect(JSON.stringify(chatJson.mock.calls[0])).not.toContain('"t-shirt"');
  });

  it('keeps the toolbar out of the page the observer sees', async () => {
    const rec = await open(environment());
    const count = await rec.page.evaluate(() => document.querySelectorAll('[id="__s1pilot-recorder"]').length);
    expect(count).toBe(1);
    const buttons = await rec.page.getByRole('button', { name: 'Stop' }).count();
    expect(buttons).toBe(0);
    await rec.cancel();
  });
});
