import { createRedactor } from '@s1pilot/domain';
import { MockDecisionModel } from '@s1pilot/providers';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LearnedRecorder, buildLearnedScript } from '../learned/recorder.js';
import { createMemoryTraceWriter } from '../trace/index.js';

import { exploreStep } from './explore-step.js';
import { replayWithHeal } from './heal.js';
import { MOCK_CAPS_FOR_TESTS, makeVars } from './test-support.js';
import type { EngineContext } from './types.js';
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_PAUSE_MS, parseWait, performWait } from './wait.js';

vi.setConfig({ testTimeout: 30_000 });

describe('parseWait', () => {
  it('reads fixed pauses', () => {
    expect(parseWait('Wait 5 seconds')).toEqual({ kind: 'pause', ms: 5000 });
    expect(parseWait('wait for 1.5 s')).toEqual({ kind: 'pause', ms: 1500 });
    expect(parseWait('Pause 500ms')).toEqual({ kind: 'pause', ms: 500 });
    expect(parseWait('Wait 2 minutes.')).toEqual({ kind: 'pause', ms: 120_000 });
    expect(parseWait('Wait 3')).toEqual({ kind: 'pause', ms: 3000 });
    expect(parseWait('Wait 60 minutes')).toEqual({ kind: 'pause', ms: MAX_PAUSE_MS });
  });

  it('reads text conditions with an optional limit', () => {
    expect(parseWait('Wait until "Upload complete" appears')).toEqual({
      kind: 'text',
      text: 'Upload complete',
      appear: true,
      timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
    });
    expect(parseWait('Wait for "Loading..." to disappear, up to 60 seconds')).toEqual({
      kind: 'text',
      text: 'Loading...',
      appear: false,
      timeoutMs: 60_000,
    });
    expect(parseWait('Wait until "Saving" is gone within 10 s')).toMatchObject({ appear: false, timeoutMs: 10_000 });
    expect(parseWait('Wait for "Welcome"')).toMatchObject({ text: 'Welcome', appear: true });
  });

  it('reads page loads', () => {
    expect(parseWait('Wait for the page to load')).toEqual({ kind: 'load', timeoutMs: DEFAULT_WAIT_TIMEOUT_MS });
    expect(parseWait('Wait until page finishes loading')).toMatchObject({ kind: 'load' });
  });

  it('leaves ordinary steps alone', () => {
    expect(parseWait('Click Save and wait 5 seconds')).toBeUndefined();
    expect(parseWait('Wait for the results')).toBeUndefined();
    expect(parseWait('Waitlist: join "Beta"')).toBeUndefined();
    expect(parseWait('Type "wait 5 seconds" in Notes')).toBeUndefined();
  });
});

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

/** Page that shows "Done" after 600 ms and removes "Loading" at the same time. */
async function delayedPage(): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.setContent(`<p id="s">Loading</p><script>setTimeout(() => { document.getElementById('s').textContent = 'Done'; }, 600);</script>`);
  return page;
}

describe('performWait', () => {
  it('waits for text to appear and to disappear', async () => {
    const page = await delayedPage();
    expect(await performWait(page, { kind: 'text', text: 'done', appear: true, timeoutMs: 5000 })).toEqual({ ok: true });
    expect(await performWait(page, { kind: 'text', text: 'Loading', appear: false, timeoutMs: 100 })).toEqual({ ok: true });
  });

  it('fails with a message when the condition is not met in time', async () => {
    const page = await delayedPage();
    const out = await performWait(page, { kind: 'text', text: 'Never', appear: true, timeoutMs: 300 });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/"Never" did not appear after 0 s/);
  });

  it('pauses for the given time', async () => {
    const page = await delayedPage();
    const t = Date.now();
    expect((await performWait(page, { kind: 'pause', ms: 300 })).ok).toBe(true);
    expect(Date.now() - t).toBeGreaterThanOrEqual(290);
  });
});

function ctxFor(page: Page): EngineContext {
  const vars = makeVars({});
  return {
    page,
    // Any model call would fail the test: wait steps must not ask the model.
    s1: new MockDecisionModel({
      fallback: () => {
        throw new Error('model called');
      },
    }),
    vars,
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

describe('wait steps in explore and replay', () => {
  const action = 'Wait until "Done" appears, up to 5 seconds';
  const steps = [{ action }];

  it('explores without a model call and replays by waiting again', async () => {
    const recorder = new LearnedRecorder('run1', steps);
    const explored = await exploreStep({ ...ctxFor(await delayedPage()), recorder }, { index: 0, action });
    expect(explored).toMatchObject({ status: 'passed', ended: 'step_done', iterations: 0 });
    expect(explored.actions).toEqual([{ kind: 'wait', target: 'wait until "Done" appears', ok: true }]);

    const script = buildLearnedScript({ caseId: 'c1', caseVersion: 1, environmentId: 'e1', runId: 'run1', verdict: 'passed', recorder });
    if (!script) throw new Error('no script learned');
    const replayed = await replayWithHeal(ctxFor(await delayedPage()), { caseId: 'c1', environmentId: 'e1', steps: [{ index: 0, action }], script });
    expect(replayed.status).toBe('passed');
    expect(replayed.steps[0]).toMatchObject({ mode: 'replay', status: 'passed' });

    // The text never shows: replay fails without trying to heal (which would call the model).
    const page = await (await browser.newContext()).newPage();
    await page.setContent('<p>Loading</p>');
    const quick = [{ index: 0, action: 'Wait until "Done" appears within 300 ms' }];
    const failed = await replayWithHeal(ctxFor(page), { caseId: 'c1', environmentId: 'e1', steps: quick, script });
    expect(failed.status).toBe('failed');
    expect(failed.steps[0]?.replay.break?.message).toMatch(/did not appear/);
  });

  it('fails the explored step when the text never appears', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.setContent('<p>Loading</p>');
    const out = await exploreStep(ctxFor(page), { index: 0, action: 'Wait until "Done" appears within 300 ms' });
    expect(out).toMatchObject({ status: 'failed', ended: 'error' });
    expect(out.reason).toMatch(/"Done" did not appear/);
  });
});
