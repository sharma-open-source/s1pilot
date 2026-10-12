import { describe, expect, it } from 'vitest';

import { normalizeRange } from './input-values.js';

describe('normalizeRange', () => {
  const b = { min: 0, max: 100, step: 1 };

  it('accepts numbers in range and snaps to the step', () => {
    expect(normalizeRange('80', b)).toEqual({ ok: true, value: '80' });
    expect(normalizeRange(' 80.4 ', b)).toEqual({ ok: true, value: '80' });
    expect(normalizeRange('7', { min: 0, max: 100, step: 5 })).toEqual({ ok: true, value: '5' });
    expect(normalizeRange('0.35', { min: 0, max: 1, step: 0.1 })).toEqual({ ok: true, value: '0.4' });
    expect(normalizeRange('0.123', { min: 0, max: 1 })).toEqual({ ok: true, value: '0.123' });
  });

  it('rejects values outside the range or not numbers, without echoing them', () => {
    const out = normalizeRange('150', b);
    expect(out).toEqual({ ok: false, message: 'The slider value is outside its range 0 to 100' });
    expect(normalizeRange('loud', b)).toMatchObject({ ok: false, message: expect.stringMatching(/not a number/) });
    expect(normalizeRange('', b)).toMatchObject({ ok: false });
  });
});
