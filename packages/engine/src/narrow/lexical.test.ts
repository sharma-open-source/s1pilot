import { describe, expect, it } from 'vitest';

import type { ObservedElement } from '../observer/types.js';

import { matchingTexts } from './lexical.js';

function text(i: number, body: string, role = 'text'): ObservedElement {
  return { id: `t${i}`, role, name: body, text: body, state: {}, box: { x: 0, y: i * 20, w: 100, h: 20 }, locators: [] };
}

describe('matchingTexts', () => {
  const texts = [
    text(1, 'Fixture Shop'),
    text(2, 'Read what other customers say in the reviews below and share yours'),
    text(3, 'Customer reviews', 'heading'),
    text(4, 'Free shipping on orders over $50'),
  ];

  it('offers text blocks matching the step, best first, headings before longer text', () => {
    expect(matchingTexts(texts, 'Navigate to the customer reviews section').map((t) => t.id)).toEqual(['t3', 't2']);
    expect(matchingTexts(texts, 'Click on Free shipping').map((t) => t.id)).toEqual(['t4']);
  });

  it('offers nothing for unrelated steps and respects the limit', () => {
    expect(matchingTexts(texts, 'Log in with valid credentials')).toEqual([]);
    expect(matchingTexts(texts, 'Scroll to reviews', 1).map((t) => t.id)).toEqual(['t3']);
  });
});
