import type { Page } from 'playwright';

import { waitWhileBusy } from '../executor/waits.js';

/**
 * A step that only waits, read from its wording (no model involved):
 * - `pause`: `Wait 5 seconds`, `Pause for 500 ms`;
 * - `text`: `Wait until "Upload complete" appears` / `… disappears`, optionally `up to 60 seconds`;
 * - `load`: `Wait for the page to load` (also waits for loading indicators to go).
 */
export type WaitStep =
  | { kind: 'pause'; ms: number }
  | { kind: 'text'; text: string; appear: boolean; timeoutMs: number }
  | { kind: 'load'; timeoutMs: number };

/** Longest fixed pause a step may ask for. */
export const MAX_PAUSE_MS = 5 * 60_000;
/** How long `wait until "…"` polls when the step gives no limit. */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

/** `5 seconds` / `1.5 s` / `500ms` / `2 minutes` → milliseconds, or undefined. */
function durationMs(amount: string, unit: string): number | undefined {
  const u = unit.toLowerCase();
  const factor = u === 'ms' || u.startsWith('milli') ? 1 : u.startsWith('s') ? 1000 : u.startsWith('m') ? 60_000 : undefined;
  const n = Number(amount);
  if (factor === undefined || !Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * factor);
}

const DURATION = String.raw`(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b`;
/** A bare number (`Wait 5`) means seconds. */
const PAUSE = /^\s*(?:wait|pause|sleep)\s+(?:for\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)?\s*\.?\s*$/i;
const LIMIT = new RegExp(String.raw`\b(?:up\s+to|for\s+up\s+to|within|at\s+most|max(?:imum)?|timeout)\s+${DURATION}`, 'i');
const TEXT = /^\s*wait\s+(?:until|till|for)\s+(?:the\s+text\s+)?"([^"]+)"\s*(?:text\s+)?(?:to\s+)?(.*)$/i;
const LOAD = /^\s*wait\s+(?:until|till|for)\s+(?:the\s+)?page\s+(?:to\s+|has\s+|is\s+)?(?:load|loads|loaded|finish(?:es)?\s+loading|finished\s+loading)\b/i;
const DISAPPEAR = /\b(disappear|disappears|vanish(?:es)?|go(?:es)?\s+away|is\s+gone|gone|is\s+hidden|hidden|is\s+not\s+(?:shown|visible|displayed)|no\s+longer\s+(?:shown|visible|displayed))\b/i;

/**
 * Reads a {@link WaitStep} from the step text, or undefined when the step is not a pure wait step.
 * Only steps that start with "wait" (or "pause"/"sleep" for fixed pauses) qualify, so "Click Save
 * and wait" stays an ordinary step.
 */
export function parseWait(text: string): WaitStep | undefined {
  const pause = PAUSE.exec(text);
  if (pause?.[1]) {
    const ms = durationMs(pause[1], pause[2] ?? 's');
    return ms === undefined ? undefined : { kind: 'pause', ms: Math.min(ms, MAX_PAUSE_MS) };
  }
  const limit = LIMIT.exec(text);
  const limitMs = limit?.[1] && limit[2] ? durationMs(limit[1], limit[2]) : undefined;
  const timeoutMs = Math.min(limitMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_PAUSE_MS);
  const quoted = TEXT.exec(text);
  if (quoted?.[1]) {
    return { kind: 'text', text: quoted[1], appear: !DISAPPEAR.test(quoted[2] ?? ''), timeoutMs };
  }
  if (LOAD.test(text)) return { kind: 'load', timeoutMs };
  return undefined;
}

/** Short description for the step's action log (`wait 5000 ms`, `wait until "Saved" appears`). */
export function describeWait(w: WaitStep): string {
  if (w.kind === 'pause') return `wait ${w.ms} ms`;
  if (w.kind === 'load') return 'wait for the page to load';
  return `wait until "${w.text}" ${w.appear ? 'appears' : 'disappears'}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether `text` is shown on the page (visible text, case and whitespace ignored, frames included). */
async function shown(page: Page, text: string): Promise<boolean> {
  const needle = text.replace(/\s+/g, ' ').trim().toLowerCase();
  for (const frame of page.frames()) {
    const found = await frame
      .evaluate((n) => (document.body?.innerText ?? '').replace(/\s+/g, ' ').toLowerCase().includes(n), needle)
      .catch(() => false);
    if (found) return true;
  }
  return false;
}

/** Outcome of {@link performWait}; `message` explains a timeout (it may contain step text: redact it). */
export interface WaitOutcome {
  ok: boolean;
  message?: string;
}

/** Performs a {@link WaitStep} on `page`. Never throws; `signal` ends a long wait early (as a failure). */
export async function performWait(page: Page, w: WaitStep, signal?: AbortSignal): Promise<WaitOutcome> {
  if (w.kind === 'pause') {
    const end = Date.now() + w.ms;
    while (Date.now() < end) {
      if (signal?.aborted) return { ok: false, message: 'Wait aborted' };
      await sleep(Math.min(POLL_MS, end - Date.now()));
    }
    return { ok: true };
  }
  if (w.kind === 'load') {
    try {
      await page.waitForLoadState('load', { timeout: w.timeoutMs });
      await page.waitForLoadState('networkidle', { timeout: w.timeoutMs }).catch(() => undefined);
      await waitWhileBusy(page, w.timeoutMs);
      return { ok: true };
    } catch {
      return { ok: false, message: `The page did not finish loading within ${Math.round(w.timeoutMs / 1000)} s` };
    }
  }
  const end = Date.now() + w.timeoutMs;
  for (;;) {
    if ((await shown(page, w.text)) === w.appear) return { ok: true };
    if (signal?.aborted) return { ok: false, message: 'Wait aborted' };
    if (Date.now() >= end) {
      return {
        ok: false,
        message: `"${w.text}" ${w.appear ? 'did not appear' : 'was still shown'} after ${Math.round(w.timeoutMs / 1000)} s`,
      };
    }
    await sleep(POLL_MS);
  }
}
