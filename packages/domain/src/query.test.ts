import { describe, expect, it } from 'vitest';

import {
  matchesCaseQuery,
  matchesDefectQuery,
  matchesQuery,
  parseCaseQuery,
  parseDefectQuery,
  parseQuery,
  type QueryClause,
  type QueryNode,
} from './query.js';

const c = (over: Partial<Parameters<typeof matchesCaseQuery>[0]> = {}) => ({
  key: 'SHOP-TC-1',
  title: 'Checkout as guest',
  tags: ['checkout', 'smoke'],
  priority: 'P1' as const,
  status: 'ready' as const,
  owner: 'ann',
  ...over,
});

const clause = (c: QueryClause): QueryNode => ({ type: 'clause', clause: c });

describe('parseCaseQuery', () => {
  it('parses tags AND priority<=', () => {
    expect(parseCaseQuery('tags:checkout AND priority<=P1')).toEqual({
      type: 'and',
      left: clause({ kind: 'tag', value: 'checkout' }),
      right: clause({ kind: 'priority', op: '<=', value: 'P1' }),
    });
  });

  it('parses status, owner, quotes and free text with implicit AND', () => {
    const q = parseCaseQuery('status:ready owner:"Ann Lee" guest priority:p0');
    expect(q).toEqual({
      type: 'and',
      left: {
        type: 'and',
        left: { type: 'and', left: clause({ kind: 'status', value: 'ready' }), right: clause({ kind: 'owner', value: 'Ann Lee' }) },
        right: clause({ kind: 'text', value: 'guest' }),
      },
      right: clause({ kind: 'priority', op: '=', value: 'P0' }),
    });
    expect(parseCaseQuery('  ')).toEqual({ type: 'all' });
  });

  it('parses every field', () => {
    const kinds = ['suite:Checkout', 'type:smoke', 'requirement:REQ-1', 'learned:yes', 'lastResult:failed', 'quarantined:no', 'lastResult:none']
      .map((t) => (parseQuery(t) as { clause: QueryClause }).clause);
    expect(kinds).toEqual([
      { kind: 'suite', value: 'Checkout' },
      { kind: 'type', value: 'smoke' },
      { kind: 'requirement', value: 'REQ-1' },
      { kind: 'learned', value: true },
      { kind: 'lastResult', value: 'failed' },
      { kind: 'quarantined', value: false },
      { kind: 'lastResult', value: 'none' },
    ]);
  });

  it('gives OR lower precedence than AND and honours NOT and parentheses', () => {
    expect(parseQuery('a OR b AND c')).toMatchObject({ type: 'or', right: { type: 'and' } });
    expect(parseQuery('(a OR b) AND c')).toMatchObject({ type: 'and', left: { type: 'or' } });
    expect(parseQuery('NOT a AND b')).toMatchObject({ type: 'and', left: { type: 'not' } });
    expect(parseQuery('NOT (a OR b)')).toMatchObject({ type: 'not', node: { type: 'or' } });
    expect(parseQuery('"OR"')).toEqual(clause({ kind: 'text', value: 'OR' }));
  });

  it('rejects bad input with a position', () => {
    const cases: [string, number][] = [
      ['priority<=P9', 0],
      ['status:nope', 0],
      ['tags:', 0],
      ['owner:"x', 6],
      ['a OR', 4],
      ['a AND AND b', 6],
      ['(a OR b', 0],
      ['a OR b)', 6],
      ['()', 0],
      ['tags:x learned:maybe', 7],
      ['OR a', 0],
    ];
    for (const [q, position] of cases) {
      expect(() => parseCaseQuery(q), q).toThrowError(expect.objectContaining({ code: 'INVALID_QUERY', details: expect.objectContaining({ position }) }));
    }
    expect(() => parseQuery('tags:a OR')).toThrowError(/position 9/);
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

describe('defect query', () => {
  const d = { key: 'DEF-3', title: 'Invalid ZIP accepted', status: 'open', severity: 'S2', tracker: 'jira' };
  it('filters on status, severity, tracker and text with the shared grammar', () => {
    expect(matchesDefectQuery(d, parseDefectQuery('status:open'))).toBe(true);
    expect(matchesDefectQuery(d, parseDefectQuery('status:closed OR severity:s2'))).toBe(true);
    expect(matchesDefectQuery(d, parseDefectQuery('tracker:none'))).toBe(false);
    expect(matchesDefectQuery({ ...d, tracker: undefined }, parseDefectQuery('tracker:none AND zip'))).toBe(true);
    expect(matchesDefectQuery(d, parseDefectQuery('NOT (status:draft OR def-3)'))).toBe(false);
    expect(matchesDefectQuery(d, parseDefectQuery(''))).toBe(true);
  });
  it('rejects unknown values with a position', () => {
    expect(() => parseDefectQuery('open status:nope')).toThrowError(/Unknown status "nope"/);
  });
});

describe('matchesQuery', () => {
  const row = { ...c(), type: 'smoke' as const, requirements: ['REQ-1'], suites: ['Payment', 'Checkout'], learned: true, lastResult: 'failed' };
  it('evaluates boolean structure and context fields', () => {
    expect(matchesQuery(row, parseQuery('suite:checkout AND learned:yes AND lastResult:failed'))).toBe(true);
    expect(matchesQuery(row, parseQuery('suite:Search OR requirement:req-1'))).toBe(true);
    expect(matchesQuery(row, parseQuery('NOT (type:smoke OR quarantined:yes)'))).toBe(false);
    expect(matchesQuery(c(), parseQuery('lastResult:none quarantined:no learned:no'))).toBe(true);
  });
});
