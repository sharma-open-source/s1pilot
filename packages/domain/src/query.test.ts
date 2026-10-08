import { describe, expect, it } from 'vitest';

import { matchesCaseQuery, parseCaseQuery } from './query.js';

const c = (over: Partial<Parameters<typeof matchesCaseQuery>[0]> = {}) => ({
  key: 'SHOP-TC-1',
  title: 'Checkout as guest',
  tags: ['checkout', 'smoke'],
  priority: 'P1' as const,
  status: 'ready' as const,
  owner: 'ann',
  ...over,
});

describe('parseCaseQuery', () => {
  it('parses tags AND priority<=', () => {
    expect(parseCaseQuery('tags:checkout AND priority<=P1').clauses).toEqual([
      { kind: 'tag', value: 'checkout' },
      { kind: 'priority', op: '<=', value: 'P1' },
    ]);
  });

  it('parses status, owner, quotes and free text', () => {
    expect(parseCaseQuery('status:ready owner:"Ann Lee" guest priority:p0').clauses).toEqual([
      { kind: 'status', value: 'ready' },
      { kind: 'owner', value: 'Ann Lee' },
      { kind: 'text', value: 'guest' },
      { kind: 'priority', op: '=', value: 'P0' },
    ]);
    expect(parseCaseQuery('  ').clauses).toEqual([]);
  });

  it('rejects bad input', () => {
    for (const q of ['priority<=P9', 'status:nope', 'tags:', 'a OR b', 'owner:"x']) {
      expect(() => parseCaseQuery(q)).toThrowError(expect.objectContaining({ code: 'INVALID_QUERY' }));
    }
  });
});

describe('matchesCaseQuery', () => {
  it('filters by tag and priority', () => {
    const q = parseCaseQuery('tags:checkout AND priority<=P1');
    expect(matchesCaseQuery(c(), q)).toBe(true);
    expect(matchesCaseQuery(c({ priority: 'P2' }), q)).toBe(false);
    expect(matchesCaseQuery(c({ tags: ['cart'] }), q)).toBe(false);
  });

  it('matches status, owner and text on title or key', () => {
    expect(matchesCaseQuery(c(), parseCaseQuery('status:ready owner:ANN guest'))).toBe(true);
    expect(matchesCaseQuery(c(), parseCaseQuery('tc-1'))).toBe(true);
    expect(matchesCaseQuery(c({ owner: undefined }), parseCaseQuery('owner:ann'))).toBe(false);
    expect(matchesCaseQuery(c(), parseCaseQuery('priority>P1'))).toBe(false);
  });
});
