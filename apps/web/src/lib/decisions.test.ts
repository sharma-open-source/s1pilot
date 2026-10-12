import { describe, expect, it } from 'vitest';

import { optionText } from './decisions';

describe('optionText', () => {
  it('adds the readable label to an option id', () => {
    expect(optionText({ optionLabels: { e29: '[textbox] Search' } }, 'e29')).toBe('e29 · [textbox] Search');
  });

  it('falls back to the id for records without labels', () => {
    expect(optionText({}, 'r1')).toBe('r1');
    expect(optionText({ optionLabels: { true: 'true' } }, 'true')).toBe('true');
  });

  it('shortens long labels', () => {
    const text = optionText({ optionLabels: { r1: `main (40 elements): ${'x'.repeat(200)}` } }, 'r1');
    expect(text.length).toBeLessThanOrEqual(85);
    expect(text.endsWith('…')).toBe(true);
  });
});
