import { createRedactor, type DecisionModel } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel } from '@s1pilot/providers';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { waitWhileBusy } from '../executor/waits.js';
import { LearnedRecorder, buildLearnedScript } from '../learned/recorder.js';
import { createMemoryTraceWriter } from '../trace/index.js';

import { exploreStep } from './explore-step.js';
import { replayWithHeal } from './heal.js';
import { MOCK_CAPS_FOR_TESTS, makeVars, scriptedS1 } from './test-support.js';
import type { EngineContext } from './types.js';

vi.setConfig({ testTimeout: 90_000 });

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

// No "Wait …" steps: the engine itself has to wait for the loaders between pages.
const STEPS = [{ action: 'Click "Load orders"' }, { action: 'Click "Next page"' }, { action: 'Type "Alex" in Name and click Save' }];
const PLAN = {
  'Click "Load orders"': ['[button] Load orders'],
  'Click "Next page"': ['[link] Next page'],
  'Type "Alex"': ['[textbox] Name', '[button] Save'],
};

/** Mock System 1 that counts its calls. */
function countingS1(): DecisionModel & { calls: number } {
  const inner = new MockDecisionModel({ fallback: scriptedS1(PLAN) });
  const model = {
    calls: 0,
    capabilities: inner.capabilities,
    decide: (req: Parameters<DecisionModel['decide']>[0]) => {
      model.calls += 1;
      return inner.decide(req);
    },
  };
  return model;
}

function ctxFor(page: Page, s1: DecisionModel): EngineContext {
  return {
    page,
    s1,
    vars: makeVars({}),
    params: {},
    environment: { requireApprovalFor: [] },
    thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 },
    caps: MOCK_CAPS_FOR_TESTS,
    redactor: createRedactor({ secrets: [], patterns: [] }),
    emit: () => undefined,
    trace: createMemoryTraceWriter(),
    budgets: {},
    runId: 'run1',
    caseResultId: 'cr1',
  };
}

async function openSlow(query: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.url}/slow${query}`);
  return page;
}

describe('waitWhileBusy', () => {
  it.each(['busy', 'spinner', 'text'])('waits for a %s loader to go and reports it waited', async (loader) => {
    const page = await openSlow(`?delay=800&loader=${loader}`);
    await page.getByRole('button', { name: 'Load orders' }).click();
    expect(await waitWhileBusy(page, 5000)).toBe(true);
    await expect(page.getByRole('link', { name: 'Next page' }).count()).resolves.toBe(1);
  });

  it('returns at once on a page without a loader', async () => {
    const page = await openSlow('');
    const t = Date.now();
    expect(await waitWhileBusy(page)).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('multi-page flow with loaders, no wait steps', () => {
  it.each([
    ['aria-busy status, 2.5 s', '?delay=2500&loader=busy'],
    ['CSS spinner, 2.5 s', '?delay=2500&loader=spinner'],
    ['"Loading…" text, 2.5 s', '?delay=2500&loader=text'],
    ['no indicator, 2.5 s', '?delay=2500&loader=none'],
    ['slow server 3 s + spinner 1 s', '?delay=1000&serve=3000&loader=spinner'],
  ])('%s: explores to the last page, then replays with no model call', async (_name, query) => {
    const page = await openSlow(query);
    const ctx = { ...ctxFor(page, countingS1()), recorder: new LearnedRecorder('run1', STEPS) };
    for (const [index, step] of STEPS.entries()) {
      const out = await exploreStep(ctx, { index, action: step.action });
      expect(out.status, `step ${index + 1}: ${out.reason ?? ''}`).toBe('passed');
    }
    await expect(ctx.page.getByRole('status').textContent()).resolves.toBe('Saved for Alex');

    const script = buildLearnedScript({ caseId: 'c1', caseVersion: 1, environmentId: 'e1', runId: 'run1', verdict: 'passed', recorder: ctx.recorder });
    if (!script) throw new Error('no script learned');
    const s1 = countingS1();
    const replayCtx = ctxFor(await openSlow(query), s1);
    const replayed = await replayWithHeal(replayCtx, { caseId: 'c1', environmentId: 'e1', steps: STEPS.map((s, index) => ({ index, action: s.action })), script });
    expect(replayed.status).toBe('passed');
    expect(replayed.steps.map((s) => s.mode)).toEqual(['replay', 'replay', 'replay']);
    expect(s1.calls).toBe(0);
    await expect(replayCtx.page.getByRole('status').textContent()).resolves.toBe('Saved for Alex');
  });
});
