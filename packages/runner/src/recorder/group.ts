import type { StepGroup, TimelineItem } from './types.js';

/** Default pause (ms) between two actions that starts a new step. */
export const DEFAULT_GAP_MS = 4000;

/** True for a group made only of clicks that navigated (pass-through links or buttons). */
function isPassThrough(g: StepGroup): boolean {
  return g.expected === undefined && g.actions.length > 0 && g.actions.every((x) => x.kind === 'click' && x.navigated);
}

/**
 * Groups the recording timeline into steps.
 *
 * A step ends after an action that navigated, before an action that follows a pause longer than
 * `gapMs`, and at an explicit expected result (which is attached to the step it ends; an expected
 * result with no new actions since the last step is appended to that step). Consecutive
 * pass-through clicks (each a lone click that navigated, without a long pause) are merged so that
 * "Cart", "Checkout", "Guest checkout" is one step rather than three.
 */
export function groupTimeline(items: readonly TimelineItem[], gapMs: number = DEFAULT_GAP_MS): StepGroup[] {
  const groups: StepGroup[] = [];
  let current: StepGroup = { actions: [] };
  const flush = (): void => {
    if (current.actions.length > 0) groups.push(current);
    current = { actions: [] };
  };
  for (const item of items) {
    if (item.type === 'expect') {
      if (current.actions.length > 0) {
        current.expected = current.expected ? `${current.expected}; ${item.text}` : item.text;
        flush();
      } else {
        const last = groups[groups.length - 1];
        if (last) last.expected = last.expected ? `${last.expected}; ${item.text}` : item.text;
      }
      continue;
    }
    const a = item.action;
    const prev = current.actions[current.actions.length - 1];
    if (prev && a.ts - prev.ts > gapMs) flush();
    current.actions.push(a);
    if (a.navigated) flush();
  }
  flush();

  const merged: StepGroup[] = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    const prevLast = prev?.actions[prev.actions.length - 1];
    const first = g.actions[0];
    if (prev && prevLast && first && isPassThrough(prev) && isPassThrough(g) && first.ts - prevLast.ts <= gapMs) {
      prev.actions.push(...g.actions);
    } else {
      merged.push({ actions: [...g.actions], ...(g.expected !== undefined ? { expected: g.expected } : {}) });
    }
  }
  return merged;
}
