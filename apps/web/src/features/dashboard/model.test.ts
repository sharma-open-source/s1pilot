import { describe, expect, it } from 'vitest';

import { applyRunMessage, browsersLabel, relativeTime } from './model';

describe('applyRunMessage', () => {
  it('reads the step from a snapshot, events and ignores noise', () => {
    let s = applyRunMessage({ current: null }, { type: 'snapshot', steps: [{ stepIndex: 0 }, { stepIndex: 3 }] });
    expect(s).toEqual({ current: 4 });
    s = applyRunMessage(s, { type: 'event', event: { type: 'case.started' } });
    expect(s).toEqual({ current: null });
    s = applyRunMessage(s, { type: 'event', event: { type: 'step.started', stepIndex: 0 } });
    expect(s).toEqual({ current: 1 });
    expect(applyRunMessage(s, 'nope')).toBe(s);
    expect(applyRunMessage(s, { type: 'event', event: { type: 'decision.made' } })).toBe(s);
    expect(applyRunMessage({ current: 2 }, { type: 'snapshot', steps: [] })).toEqual({ current: null });
  });
});

describe('labels', () => {
  it('formats browsers and relative times', () => {
    expect(browsersLabel([])).toBeNull();
    expect(browsersLabel(['webkit'])).toBe('WebKit');
    expect(browsersLabel(['chromium', 'firefox'])).toBe('2 browsers');
    const now = Date.parse('2026-10-08T12:00:00Z');
    expect(relativeTime(null)).toBe('Never');
    expect(relativeTime('2026-10-08T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-10-08T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-10-08T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-06T12:00:00Z', now)).toBe('2 d ago');
  });
});
