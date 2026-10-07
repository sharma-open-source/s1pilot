import type { Question } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { normalizeAnswer, normalizeProbabilities } from './normalize.js';

const choice: Question = { type: 'choice', instructions: 'Pick', criteria: { e1: 'Buy', e2: 'Cancel', e3: 'Back' } };
const noul: Question = { type: 'noul', instructions: 'Done?' };
const score: Question = { type: 'score', instructions: 'Rate', criteria: ['low', 'mid', 'high'] };

describe('normalizeProbabilities', () => {
  it('scales weights to sum 1', () => {
    expect(normalizeProbabilities({ a: 2, b: 6 })).toEqual({ a: 0.25, b: 0.75 });
  });

  it.each([[{}], [{ a: 0, b: 0 }], [{ a: -1, b: 2 }], [{ a: Number.NaN }]])('rejects %j', (input) => {
    expect(() => normalizeProbabilities(input)).toThrowError(expect.objectContaining({ code: 'MODEL_BAD_RESPONSE' }));
  });
});

describe('normalizeAnswer: choice', () => {
  it('normalises, fills missing options with 0 and uses max(p) as confidence', () => {
    const answer = normalizeAnswer(choice, { probabilities: { e1: 3, e3: 1 } });
    expect(answer.probabilities).toEqual({ e1: 0.75, e2: 0, e3: 0.25 });
    expect(answer).toMatchObject({ choice: 'e1', confidence: 0.75 });
    expect(Object.values(answer.probabilities).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('keeps an explicit choice and rejects unknown options', () => {
    expect(normalizeAnswer(choice, { choice: 'e2', probabilities: { e1: 0.5, e2: 0.5 } }).choice).toBe('e2');
    expect(() => normalizeAnswer(choice, { choice: 'e9', probabilities: { e1: 1 } })).toThrow(/unknown option/);
    expect(() => normalizeAnswer(choice, { probabilities: { e9: 1 } })).toThrow(/unknown option/);
    expect(() => normalizeAnswer(choice, {})).toThrow(/no probabilities/);
  });

  it('breaks ties by option order', () => {
    expect(normalizeAnswer(choice, { probabilities: { e1: 1, e2: 1, e3: 1 } }).choice).toBe('e1');
  });
});

describe('normalizeAnswer: noul', () => {
  it('maps P(true) to { true, false } and confidence max(p, 1-p)', () => {
    expect(normalizeAnswer(noul, { noul: 0.8 })).toEqual({
      noul: 0.8,
      probabilities: { true: 0.8, false: expect.closeTo(0.2) },
      confidence: 0.8,
    });
    expect(normalizeAnswer(noul, { noul: 0.1 }).confidence).toBeCloseTo(0.9);
  });

  it('derives P(true) from true/false weights', () => {
    expect(normalizeAnswer(noul, { probabilities: { true: 3, false: 1 } }).noul).toBe(0.75);
    expect(normalizeAnswer(noul, { probabilities: { true: 0.6 } }).noul).toBe(0.6);
  });

  it('rejects missing or out-of-range values', () => {
    expect(() => normalizeAnswer(noul, {})).toThrow(/no P\(true\)/);
    expect(() => normalizeAnswer(noul, { noul: 1.2 })).toThrow(/out of range/);
  });
});

describe('normalizeAnswer: score', () => {
  it('picks the level index with the highest probability', () => {
    const answer = normalizeAnswer(score, { probabilities: { low: 1, mid: 1, high: 8 } });
    expect(answer).toMatchObject({ score: 2, confidence: 0.8 });
  });

  it('accepts a bare score as a one-hot answer, clamped to the levels', () => {
    expect(normalizeAnswer(score, { score: 1 })).toEqual({ score: 1, probabilities: { low: 0, mid: 1, high: 0 }, confidence: 1 });
    expect(normalizeAnswer(score, { score: 9 }).score).toBe(2);
  });
});
