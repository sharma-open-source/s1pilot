import { describe, expect, it } from 'vitest';

import { isTemporalInputType, normalizeTemporal } from './temporal.js';

const ok = (type: Parameters<typeof normalizeTemporal>[0], value: string): string | undefined => {
  const r = normalizeTemporal(type, value);
  return r.ok ? r.value : undefined;
};

describe('normalizeTemporal', () => {
  it('passes ISO dates through and converts unambiguous human formats', () => {
    expect(ok('date', '1990-01-15')).toBe('1990-01-15');
    expect(ok('date', '1990/1/5')).toBe('1990-01-05');
    expect(ok('date', '15/01/1990')).toBe('1990-01-15');
    expect(ok('date', '01/15/1990')).toBe('1990-01-15');
    expect(ok('date', '15.01.1990')).toBe('1990-01-15');
    expect(ok('date', '03/03/1990')).toBe('1990-03-03');
    expect(ok('date', '15 Jan 1990')).toBe('1990-01-15');
    expect(ok('date', '15th January 1990')).toBe('1990-01-15');
    expect(ok('date', 'Jan 15, 1990')).toBe('1990-01-15');
    expect(ok('date', 'September 9 2024')).toBe('2024-09-09');
  });

  it('rejects ambiguous, impossible and unreadable dates without echoing the value', () => {
    const amb = normalizeTemporal('date', '01/02/1990');
    expect(amb).toMatchObject({ ok: false, message: expect.stringMatching(/ambiguous.*YYYY-MM-DD/) });
    expect((amb as { message: string }).message).not.toContain('01/02/1990');
    expect(normalizeTemporal('date', '1990-02-30')).toMatchObject({ ok: false, message: expect.stringMatching(/not a real calendar date/) });
    expect(normalizeTemporal('date', 'tomorrow')).toMatchObject({ ok: false });
    expect(normalizeTemporal('date', '15/01/90')).toMatchObject({ ok: false });
  });

  it('handles time, datetime-local, month and week', () => {
    expect(ok('time', '9:05')).toBe('09:05');
    expect(ok('time', '2:30 pm')).toBe('14:30');
    expect(ok('time', '12:00 am')).toBe('00:00');
    expect(ok('time', '25:00')).toBeUndefined();
    expect(ok('datetime-local', '15/01/1990 14:30')).toBe('1990-01-15T14:30');
    expect(ok('datetime-local', '1990-01-15T09:00')).toBe('1990-01-15T09:00');
    expect(ok('month', '1990-1')).toBe('1990-01');
    expect(ok('month', '03/2024')).toBe('2024-03');
    expect(ok('month', 'March 2024')).toBe('2024-03');
    expect(ok('week', '2024-W5')).toBe('2024-W05');
    expect(ok('week', '2024-W60')).toBeUndefined();
  });

  it('recognises temporal input types', () => {
    expect(isTemporalInputType('date')).toBe(true);
    expect(isTemporalInputType('datetime-local')).toBe(true);
    expect(isTemporalInputType('text')).toBe(false);
    expect(isTemporalInputType(undefined)).toBe(false);
  });
});
