import { createRedactor } from '@s1pilot/domain';
import { MockDecisionModel } from '@s1pilot/providers';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LearnedRecorder, buildLearnedScript } from '../learned/recorder.js';
import { createMemoryTraceWriter } from '../trace/index.js';

import { exploreStep } from './explore-step.js';
import { actionsForStep, replayStep } from './replay-step.js';
import { MOCK_CAPS_FOR_TESTS, makeVars, scriptedS1 } from './test-support.js';
import type { EngineContext } from './types.js';

vi.setConfig({ testTimeout: 30_000 });

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

/** A page whose targets are plain text: an off-screen section and script-driven `div`s. */
const HTML = `
  <main>
    <h1>Fixture article</h1>
    <div id="promo" style="cursor:pointer">Show promo</div>
    <div id="del" style="cursor:pointer">Delete account</div>
    <div style="height:3000px"></div>
    <h2>Customer reviews</h2>
    <p>Great tee, fits well.</p>
  </main>
  <script>
    document.getElementById('promo').addEventListener('click', () => { document.title = 'promo shown'; });
    document.getElementById('del').addEventListener('click', () => { document.title = 'deleted'; });
  </script>`;

const vars = makeVars({});
const redactor = createRedactor({ secrets: [], patterns: [] });

async function fresh(): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
  await page.setContent(HTML);
  return page;
}

function makeCtx(page: Page, plan: Record<string, string[]>, over: Partial<EngineContext> = {}): EngineContext {
  return {
    page,
    s1: new MockDecisionModel({ fallback: scriptedS1(plan) }),
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
    ...over,
  };
}

const inView = (page: Page, name: string): Promise<boolean> =>
  page.getByRole('heading', { name }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });

describe('exploreStep with page text targets', () => {
  it('scrolls a non-interactive heading into view, and replays it from the learned script', async () => {
    const step = { action: 'Navigate to the Customer reviews section' };
    const page = await fresh();
    expect(await inView(page, 'Customer reviews')).toBe(false);
    const recorder = new LearnedRecorder('run1', [step]);
    const ctx = makeCtx(page, { [step.action]: ['[heading] Customer reviews (scroll it into view)'] }, { recorder });

    const result = await exploreStep(ctx, { index: 0, ...step });
    expect(result.status).toBe('passed');
    expect(result.actions.map((a) => [a.kind, a.target, a.ok])).toEqual([['scroll', 'Customer reviews', true]]);
    expect(await inView(page, 'Customer reviews')).toBe(true);

    const script = buildLearnedScript({ caseId: 'c1', caseVersion: 1, environmentId: 'e1', runId: 'run1', verdict: 'passed', recorder });
    if (!script) throw new Error('no script learned');
    const again = await fresh();
    const replayed = await replayStep({ page: again, vars, params: {}, redactor }, 0, actionsForStep(script, 0));
    expect(replayed.status).toBe('passed');
    expect(await inView(again, 'Customer reviews')).toBe(true);
  });

  it('clicks text with a pointer cursor', async () => {
    const page = await fresh();
    const step = 'Click on Show promo';
    const result = await exploreStep(makeCtx(page, { [step]: ['[text] Show promo (click it)'] }), { index: 0, action: step });
    expect(result.status).toBe('passed');
    expect(result.actions[0]?.kind).toBe('click');
    expect(await page.title()).toBe('promo shown');
  });

  it('treats clickable text as a button for sensitive-action approval', async () => {
    const page = await fresh();
    const step = 'Click Delete account';
    const result = await exploreStep(makeCtx(page, { [step]: ['[text] Delete account (click it)'] }), { index: 0, action: step });
    expect(result.status).toBe('blocked');
    expect(result.ended).toBe('sensitive');
    expect(await page.title()).not.toBe('deleted');
  });
});
