import { describe, expect, it } from 'vitest';

import type { ObservedElement } from '../observer/types.js';

import { lexicalScore, matchingTexts, tokenize } from './lexical.js';

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

describe('lexicalScore', () => {
  const picker: ObservedElement = { id: 'e9', role: 'textbox', name: '', inputType: 'color', nearLabel: 'Favorite Color', state: {}, box: { x: 0, y: 0, w: 20, h: 20 }, locators: [] };

  it('matches unnamed controls by nearby label and input type', () => {
    // "set", "favorite", "color", "red": the nearby label matches "favorite" and "color" (own words).
    expect(lexicalScore(tokenize('set favorite color to red'), picker)).toBe(0.5);
    // The input type is context: half weight.
    expect(lexicalScore(tokenize('set colour to red'), { ...picker, nearLabel: undefined })).toBeCloseTo(0.5 / 3);
    expect(lexicalScore(tokenize('set colour to red'), { ...picker, nearLabel: undefined, inputType: undefined })).toBe(0);
  });

  it('weighs an element\'s own words above hints and section headings', () => {
    const tokens = tokenize('Set the volume slider to "90"');
    const named: ObservedElement = { id: 'e1', role: 'slider', name: 'Volume: 50%', state: {}, box: { x: 0, y: 0, w: 1, h: 1 }, locators: [] };
    const hinted: ObservedElement = { ...named, id: 'e2', name: '', idHint: 'video volume' };
    expect(lexicalScore(tokens, named)).toBeGreaterThan(lexicalScore(tokens, hinted));
  });
});
