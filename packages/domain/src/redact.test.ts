import { describe, expect, it } from 'vitest';

import { S1PilotError } from './errors.js';
import { createRedactor } from './redact.js';

const none = { secrets: [], patterns: [] };

describe('secrets', () => {
  const secret = 'p@ss w0rd/&=é';

  it('removes the raw value anywhere in a string', () => {
    const r = createRedactor({ secrets: [secret], patterns: [], builtins: false });
    expect(r.redact(`login with ${secret} now, again ${secret}`)).toBe(
      'login with [REDACTED] now, again [REDACTED]',
    );
  });

  it('removes URL-encoded and form-encoded forms (either hex case)', () => {
    const r = createRedactor({ secrets: [secret], patterns: [], builtins: false });
    const percent = encodeURIComponent(secret);
    for (const form of [percent, percent.toLowerCase(), percent.replace(/%20/g, '+'), encodeURI(secret)]) {
      const out = r.redact(`https://x.test/?pw=${form}&a=1`);
      expect(out).toBe('https://x.test/?pw=[REDACTED]&a=1');
    }
  });

  it('removes the longer secret whole when one contains another', () => {
    const r = createRedactor({ secrets: ['abcd', 'abcd1234'], patterns: [], builtins: false });
    expect(r.redact('x abcd1234 y')).toBe('x [REDACTED] y');
  });

  it('ignores empty secrets', () => {
    expect(createRedactor({ secrets: [''], patterns: [] }).redact('plain text')).toBe('plain text');
  });
});

describe('project patterns', () => {
  it('applies regex patterns globally', () => {
    const r = createRedactor({ secrets: [], patterns: ['ORD-\\d{6}'], builtins: false });
    expect(r.redact('ORD-123456 and ORD-654321')).toBe('[REDACTED] and [REDACTED]');
  });

  it('rejects an invalid pattern with S1PilotError', () => {
    expect(() => createRedactor({ secrets: [], patterns: ['(unclosed'] })).toThrow(S1PilotError);
  });
});

describe('built-in detectors', () => {
  const r = createRedactor(none);

  it.each([
    ['email', 'contact jane.doe+x@example.co.uk please', 'contact [REDACTED:email] please'],
    ['luhn card (spaced)', 'card 4111 1111 1111 1111 ok', 'card [REDACTED:card] ok'],
    ['luhn card (dashed)', 'card 5500-0000-0000-0004 ok', 'card [REDACTED:card] ok'],
    ['bearer', 'Authorization: Bearer abcDEF123456.token-value', 'Authorization: [REDACTED:bearer]'],
    [
      'jwt',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fw done',
      'jwt [REDACTED:jwt] done',
    ],
    ['openai key', 'key sk-abcdefghijklmnopqrstuvwxyz123456', 'key [REDACTED:api-key]'],
    ['github token', `t ghp_${'a'.repeat(36)}`, 't [REDACTED:api-key]'],
    ['aws key', 'AKIAIOSFODNN7EXAMPLE', '[REDACTED:api-key]'],
    ['key=value', 'api_key=abcd1234efgh5678ijkl', '[REDACTED:api-key]'],
  ])('redacts %s', (_name, input, expected) => {
    expect(r.redact(input)).toBe(expected);
  });

  it.each([
    'order 1234567890123456 shipped', // 16 digits, fails Luhn
    'version 1.2.3-beta+build.5 released',
    'meet at 10:30 on 2026-01-31',
    'phone 555-0100',
    'user at example dot com',
    'the token was refreshed', // word "token" without a value
    'sk-short',
    'Bearer',
  ])('leaves %j alone', (input) => {
    expect(r.redact(input)).toBe(input);
  });

  it('can be disabled', () => {
    const off = createRedactor({ secrets: [], patterns: [], builtins: false });
    expect(off.redact('jane@example.com')).toBe('jane@example.com');
  });
});

describe('redactDeep', () => {
  const r = createRedactor({ secrets: ['hunter2'], patterns: [] });

  it('redacts nested strings without mutating the input', () => {
    const input = { a: 'pw hunter2', list: ['x', { b: 'hunter2' }], n: 5, ok: true, nil: null };
    const out = r.redactDeep(input);
    expect(out).toEqual({ a: 'pw [REDACTED]', list: ['x', { b: '[REDACTED]' }], n: 5, ok: true, nil: null });
    expect(input.a).toBe('pw hunter2');
  });

  it('handles cycles and errors', () => {
    const cyclic: Record<string, unknown> = { v: 'hunter2' };
    cyclic['self'] = cyclic;
    expect(r.redactDeep(cyclic)).toEqual({ v: '[REDACTED]', self: '[Circular]' });
    const err = r.redactDeep(new Error('bad hunter2')) as unknown as { message: string };
    expect(err.message).toBe('bad [REDACTED]');
  });
});
