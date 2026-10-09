import { describe, expect, it } from 'vitest';

import { manualElapsedMs, manualStepStatus, PlanAssignmentSchema, worstManualVerdict } from './manual.js';

describe('manual execution helpers', () => {
  it('derives the case verdict from the worst step verdict', () => {
    expect(worstManualVerdict(['pass', 'pass'])).toBe('passed');
    expect(worstManualVerdict(['pass', 'na'])).toBe('passed');
    expect(worstManualVerdict(['pass', 'blocked', 'na'])).toBe('blocked');
    expect(worstManualVerdict(['blocked', 'fail', 'pass'])).toBe('failed');
    expect(worstManualVerdict(['na', 'na'])).toBe('skipped');
  });

  it('maps step verdicts to step statuses', () => {
    expect(['pass', 'fail', 'blocked', 'na'].map((v) => manualStepStatus(v as 'pass'))).toEqual(['passed', 'failed', 'blocked', 'skipped']);
  });

  it('adds the running stretch to the persisted elapsed time', () => {
    const now = new Date('2026-10-09T10:01:00.000Z');
    expect(manualElapsedMs({ elapsedMs: 5000 }, now)).toBe(5000);
    expect(manualElapsedMs({ elapsedMs: 5000, timerStartedAt: '2026-10-09T10:00:00.000Z' }, now)).toBe(65_000);
  });

  it('defaults plan assignments', () => {
    expect(PlanAssignmentSchema.parse({})).toEqual({ manual: false, hybrid: false });
  });
});
