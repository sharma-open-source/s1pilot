import { describe, expect, it } from 'vitest';

import { FLAKY_WINDOW, flakinessScore } from './flaky.js';

describe('flakinessScore', () => {
  it('is 0 for stable and empty histories', () => {
    expect(flakinessScore([])).toBe(0);
    expect(flakinessScore(['passed', 'passed', 'passed'])).toBe(0);
    expect(flakinessScore(['failed', 'failed', 'failed'])).toBe(0);
  });

  it('counts flaky verdicts and pass/fail flips', () => {
    expect(flakinessScore(['passed', 'flaky'])).toBe(0.5);
    expect(flakinessScore(['passed', 'failed', 'passed', 'failed'])).toBe(0.75);
    expect(flakinessScore(['passed', 'passed', 'passed', 'failed'])).toBe(0.25);
  });

  it('ignores skipped and needs-review, and only looks at the last 20 executions', () => {
    expect(flakinessScore(['passed', 'skipped', 'needs-review', 'passed'])).toBe(0);
    const old = Array.from({ length: 10 }, () => 'flaky' as const);
    const recent = Array.from({ length: FLAKY_WINDOW }, () => 'passed' as const);
    expect(flakinessScore([...old, ...recent])).toBe(0);
  });
});
