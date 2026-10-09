import { describe, expect, it } from 'vitest';

import { evaluateCriteria, parseExitCriterion, type ExitCriteriaFacts } from './exit-criteria.js';

const facts = (over: Partial<ExitCriteriaFacts> = {}): ExitCriteriaFacts => ({ results: [], openDefects: [], pendingReviews: 0, ...over });
const one = (kind: string, params: Record<string, unknown>, f: ExitCriteriaFacts) => {
  const item = evaluateCriteria([{ kind, params }], f).items[0];
  if (!item) throw new Error('no item');
  return item;
};

describe('exit criteria', () => {
  it('passRate checks the percentage of the chosen priorities and ignores skipped', () => {
    const f = facts({
      results: [
        { priority: 'P0', verdict: 'passed' },
        { priority: 'P0', verdict: 'failed' },
        { priority: 'P0', verdict: 'skipped' },
        { priority: 'P1', verdict: 'failed' },
      ],
    });
    expect(one('p0-passed', { percent: 100 }, f)).toMatchObject({ met: false, actual: '50%' });
    expect(one('p0-passed', { percent: 50 }, f).met).toBe(true);
    expect(one('pass-rate', { percent: 95, priorities: ['P2'] }, f)).toMatchObject({ met: true, actual: 'no cases' });
  });

  it('noOpenDefects compares severity', () => {
    const f = facts({ openDefects: [{ severity: 'S3' }] });
    expect(one('no-open-defects', { severity: 'S2' }, f).met).toBe(true);
    expect(one('no-open-defects', { severity: 'S3' }, f).met).toBe(false);
  });

  it('reviewQueueEmpty, noFlaky and allExecuted', () => {
    expect(one('review-queue-empty', {}, facts({ pendingReviews: 2 }))).toMatchObject({ met: false, actual: '2 pending' });
    const f = facts({
      results: [
        { priority: 'P1', verdict: 'flaky' },
        { priority: 'P3', verdict: 'skipped' },
      ],
    });
    expect(one('no-flaky', { priorities: ['P1'] }, f).met).toBe(false);
    expect(one('no-flaky', { priorities: ['P0'] }, f).met).toBe(true);
    expect(one('all-executed', {}, f)).toMatchObject({ met: false, actual: '1 of 2 executed' });
  });

  it('treats unknown kinds as unmet and no criteria as met', () => {
    expect(parseExitCriterion({ kind: 'bogus', params: {} })).toBeUndefined();
    expect(evaluateCriteria([{ kind: 'bogus', params: {} }], facts()).met).toBe(false);
    expect(evaluateCriteria([], facts())).toEqual({ met: true, items: [] });
  });
});
