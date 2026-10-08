import type { Assertion, Step } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import {
  ASSERTION_TYPES,
  blankStep,
  buildAssertion,
  checkTags,
  completionAt,
  diffLines,
  duplicateStep,
  isDirty,
  moveStep,
  parsePrecondition,
  splitParams,
  summarizeAssertion,
  toDraft,
  toPatch,
  type CaseContent,
} from './model';

const CONTENT: CaseContent = {
  title: 'Guest checks out',
  priority: 'P1',
  type: 'e2e',
  status: 'ready',
  tags: ['smoke'],
  requirements: [],
  preconditions: [{ flow: 'clear-cart' }],
  parameters: [{ colour: 'blue' }],
  steps: [
    { action: 'Open {colour} tee', expected: 'Product page', assert: [], inputs: [] },
    { action: 'Add to cart', assert: [{ type: 'elementText', testId: 'status', contains: '1' }], inputs: ['name'] },
  ],
};

describe('buildAssertion', () => {
  it('produces the S-021 summaries used in the wireframe', () => {
    const url = buildAssertion('urlMatches', { pattern: '/checkout/payment' });
    const text = buildAssertion('elementText', { testId: 'status', contains: '1' });
    expect(url.ok && summarizeAssertion(url.assertion)).toBe('url ~ /checkout/payment');
    expect(text.ok && summarizeAssertion(text.assertion)).toBe('text(status) ⊇ "1"');
  });

  it('builds a value that summarises identically to a hand-written assertion of every type', () => {
    const samples: Array<[Assertion['type'], Record<string, string | boolean>, Assertion]> = [
      ['urlMatches', { pattern: 'checkout' }, { type: 'urlMatches', pattern: 'checkout' }],
      ['titleContains', { contains: 'Cart' }, { type: 'titleContains', contains: 'Cart' }],
      ['elementVisible', { role: 'button', name: 'Pay', visible: 'hidden' }, { type: 'elementVisible', role: 'button', name: 'Pay', visible: false }],
      ['elementValue', { css: '#zip', equals: '1000' }, { type: 'elementValue', css: '#zip', equals: '1000' }],
      ['elementCount', { text: 'Item', min: '2' }, { type: 'elementCount', text: 'Item', min: 2 }],
      ['responseStatus', { urlPattern: '/api/cart', status: '201', method: 'post' }, { type: 'responseStatus', urlPattern: '/api/cart', status: 201, method: 'post' }],
      ['noConsoleErrors', {}, { type: 'noConsoleErrors', allow: [] }],
      ['downloadExists', { filenamePattern: '*.pdf' }, { type: 'downloadExists', filenamePattern: '*.pdf' }],
      ['apiCheck', { url: '/api/health', status: '200', bodyContains: 'ok' }, { type: 'apiCheck', method: 'GET', url: '/api/health', status: 200, bodyContains: 'ok' }],
      ['ai', { expected: 'Cart is empty', critical: true }, { type: 'ai', expected: 'Cart is empty', critical: true }],
    ];
    for (const [type, values, expected] of samples) {
      const built = buildAssertion(type, values);
      expect(built.ok, type).toBe(true);
      if (built.ok) expect(summarizeAssertion(built.assertion), type).toBe(summarizeAssertion(expected));
    }
    expect(ASSERTION_TYPES.map((t) => t.type).sort()).toEqual(
      ['ai', 'apiCheck', 'downloadExists', 'elementCount', 'elementText', 'elementValue', 'elementVisible', 'noConsoleErrors', 'responseStatus', 'titleContains', 'urlMatches'].sort(),
    );
  });

  it('rejects missing required fields', () => {
    expect(buildAssertion('urlMatches', {})).toEqual({ ok: false, error: 'URL pattern is required' });
    expect(buildAssertion('elementText', { contains: 'x' }).ok).toBe(false);
    expect(buildAssertion('elementText', { text: 'x' }).ok).toBe(false);
    expect(buildAssertion('elementCount', { text: 'x' }).ok).toBe(false);
    expect(buildAssertion('responseStatus', { urlPattern: '/a', status: '99' }).ok).toBe(false);
  });
});

describe('draft helpers', () => {
  it('round-trips content and detects edits', () => {
    const draft = toDraft(CONTENT);
    expect(toPatch(draft)).toEqual(CONTENT);
    expect(isDirty(CONTENT, draft)).toBe(false);
    expect(isDirty(CONTENT, { ...draft, title: 'Other' })).toBe(true);
    expect(isDirty(CONTENT, { ...draft, steps: [...draft.steps, blankStep()] })).toBe(true);
  });

  it('reorders and duplicates steps', () => {
    const steps = toDraft(CONTENT).steps;
    expect(moveStep(steps, 0, 1).map((s) => s.action)).toEqual(['Add to cart', 'Open {colour} tee']);
    expect(moveStep(steps, 0, -5)).toBe(steps);
    const dup = duplicateStep(steps, 0);
    expect(dup).toHaveLength(3);
    expect(dup[1]?.action).toBe(dup[0]?.action);
    expect(dup[1]?.uid).not.toBe(dup[0]?.uid);
  });
});

describe('text helpers', () => {
  it('splits {param} chips', () => {
    expect(splitParams('Choose {colour} and {size}.')).toEqual([
      { kind: 'text', value: 'Choose ' },
      { kind: 'param', value: '{colour}' },
      { kind: 'text', value: ' and ' },
      { kind: 'param', value: '{size}' },
      { kind: 'text', value: '.' },
    ]);
  });

  it('finds autocomplete triggers at the caret', () => {
    expect(completionAt('Choose {co', 10)).toEqual({ kind: 'param', query: 'co', start: 7 });
    expect(completionAt('Do @log', 7)).toEqual({ kind: 'shared', query: 'log', start: 3 });
    expect(completionAt('a@b.com', 7)).toBeUndefined();
    expect(completionAt('Choose {colour} ', 16)).toBeUndefined();
  });

  it('derives check tags: AI by default with expected text, then assertion summaries', () => {
    const steps = toDraft(CONTENT).steps as Step[];
    expect(checkTags(steps[0] as Step).map((t) => t.label)).toEqual(['AI check']);
    expect(checkTags(steps[1] as Step).map((t) => t.label)).toEqual(['text(status) ⊇ "1"']);
  });

  it('parses preconditions', () => {
    expect(parsePrecondition('flow: clear-cart')).toEqual({ flow: 'clear-cart' });
    expect(parsePrecondition('auth:none (guest)')).toEqual({ auth: 'none (guest)' });
    expect(parsePrecondition('nonsense')).toBeUndefined();
  });

  it('diffs lines', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'remove', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
    ]);
  });
});
