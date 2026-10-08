import { describe, expect, it } from 'vitest';

import type { AssertionResult } from './deterministic.js';
import { caseVerdict, verdictFor, worstVerdict, type VerdictInput } from './policy.js';

const thresholds = { pass: 0.9, fail: 0.1 };
const ok: AssertionResult = { type: 'urlMatches', verdict: 'pass', summary: 's', message: 'm' };
const bad: AssertionResult = { ...ok, verdict: 'fail' };

function v(over: Partial<VerdictInput>) {
  return verdictFor({ thresholds, deterministic: [], priority: 'P2', allowAiOnlyPassForP0: false, ...over });
}

describe('verdictFor', () => {
  const table: [string, Partial<VerdictInput>, string][] = [
    ['AI above pass', { pTrue: 0.95 }, 'passed'],
    ['AI exactly pass', { pTrue: 0.9 }, 'passed'],
    ['AI exactly fail', { pTrue: 0.1 }, 'failed'],
    ['AI below fail', { pTrue: 0.02 }, 'failed'],
    ['AI between', { pTrue: 0.5 }, 'needs-review'],
    ['deterministic fail beats AI pass', { pTrue: 0.99, deterministic: [ok, bad] }, 'failed'],
    ['deterministic only, all pass', { deterministic: [ok] }, 'passed'],
    ['deterministic only, one fail', { deterministic: [bad] }, 'failed'],
    ['P0 AI-only pass needs review', { pTrue: 0.99, priority: 'P0' }, 'needs-review'],
    ['P0 AI-only pass allowed', { pTrue: 0.99, priority: 'P0', allowAiOnlyPassForP0: true }, 'passed'],
    ['P0 AI pass with deterministic evidence', { pTrue: 0.99, priority: 'P0', deterministic: [ok] }, 'passed'],
    ['P0 AI fail stays failed', { pTrue: 0.01, priority: 'P0' }, 'failed'],
    ['P1 AI-only pass', { pTrue: 0.99, priority: 'P1' }, 'passed'],
    ['dual-order disagreement', { pTrue: 0.95, dualOrderAgreed: false }, 'needs-review'],
    ['disagreement but deterministic fail', { pTrue: 0.95, dualOrderAgreed: false, deterministic: [bad] }, 'failed'],
  ];
  it.each(table)('%s', (_n, over, want) => {
    expect(v(over)).toBe(want);
  });
});

describe('case verdict', () => {
  it('is the worst step verdict', () => {
    expect(caseVerdict(['passed', 'needs-review', 'passed'])).toBe('needs-review');
    expect(caseVerdict(['passed', 'needs-review', 'blocked'])).toBe('blocked');
    expect(caseVerdict(['blocked', 'failed', 'passed'])).toBe('failed');
    expect(caseVerdict(['passed', 'passed'])).toBe('passed');
    expect(worstVerdict([])).toBe('passed');
  });
});
