import { describe, expect, it } from 'vitest';

import { S1PilotError } from './errors.js';
import { caseKey, newId, parseCaseKey } from './ids.js';

describe('ids', () => {
  it('generates unique 21-char ids', () => {
    const a = newId();
    expect(a).toHaveLength(21);
    expect(newId()).not.toBe(a);
  });

  it('round-trips case keys', () => {
    expect(caseKey('SHOP', 42)).toBe('SHOP-TC-42');
    expect(parseCaseKey('SHOP-TC-42')).toEqual({ projectKey: 'SHOP', number: 42 });
  });

  it('rejects bad keys with S1PilotError', () => {
    expect(() => parseCaseKey('shop-tc-1')).toThrow(S1PilotError);
    expect(() => parseCaseKey('SHOP-TC-0')).toThrow(/Invalid case key/);
    expect(() => caseKey('x', 1)).toThrow(S1PilotError);
    expect(() => caseKey('SHOP', 0)).toThrow(S1PilotError);
  });
});
