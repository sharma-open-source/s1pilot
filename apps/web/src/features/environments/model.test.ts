import { describe, expect, it } from 'vitest';

import { buildPatch, formFromEnv, parseCsv, parseDomains, previewDataset, timeAgo, validateForm, type MaskedEnv } from './model';

const ENV = {
  id: 'e1',
  projectId: 'p1',
  name: 'staging',
  baseUrl: 'https://staging.shop.example',
  variables: [
    { key: 'zip', secret: false, value: '560001', source: 'inline' },
    { key: 'pw', secret: true, masked: true, source: 'inline' },
  ],
  allowDomains: ['staging.shop.example'],
  browsers: [{ browser: 'chromium' }, { browser: 'firefox' }],
  readOnly: false,
  requireApprovalFor: ['pay', 'delete', 'send'],
  locale: 'en-US',
  timezone: 'UTC',
} as unknown as MaskedEnv;

describe('buildPatch', () => {
  it('is empty for an untouched form', () => {
    expect(buildPatch(ENV, formFromEnv(ENV))).toEqual({});
  });

  it('contains only changed fields and keeps extra browsers', () => {
    const form = { ...formFromEnv(ENV), readOnly: true, browser: 'webkit|iPhone 13', localeTz: 'de-DE|Europe/Berlin' };
    expect(buildPatch(ENV, form)).toEqual({
      readOnly: true,
      browsers: [{ browser: 'webkit', device: 'iPhone 13' }, { browser: 'firefox' }],
      locale: 'de-DE',
      timezone: 'Europe/Berlin',
    });
  });

  it('omits the value of untouched secrets', () => {
    const form = formFromEnv(ENV);
    form.variables[0] = { ...(form.variables[0] as (typeof form.variables)[number]), value: '1' };
    expect(buildPatch(ENV, form).variables).toEqual([
      { key: 'zip', secret: false, source: 'inline', value: '1' },
      { key: 'pw', secret: true, source: 'inline' },
    ]);
  });
});

describe('validateForm', () => {
  it('flags bad url, domains, duplicate keys and missing secret values', () => {
    const form = formFromEnv(ENV);
    form.baseUrl = 'nope';
    form.allowDomains = ['https://x.example/path'];
    form.variables.push({ rid: 'n1', key: 'zip', kind: 'secret-encrypted', value: '', envVar: '', source: 'inline', existing: false });
    const { ok, errors } = validateForm(form);
    expect(ok).toBe(false);
    expect(errors.baseUrl).toBeDefined();
    expect(errors.allowDomains).toContain('https://x.example/path');
    expect(errors.variables['n1']).toEqual({ key: 'Duplicate key', value: 'Secret value is required' });
  });

  it('accepts a clean form', () => {
    expect(validateForm(formFromEnv(ENV)).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('parses domains', () => {
    expect(parseDomains('a.example, b.example  a.example')).toEqual(['a.example', 'b.example']);
  });

  it('formats relative time', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(timeAgo('2026-01-01T11:55:00Z', now)).toBe('5 min ago');
    expect(timeAgo(undefined, now)).toBe('never');
  });

  it('parses CSV with quotes', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });

  it('previews JSON and rejects bad files', () => {
    const p = previewDataset('z.json', JSON.stringify([{ zip: '1' }, { zip: '2', city: 'A' }]));
    expect(p.columns).toEqual(['zip', 'city']);
    expect(p.rows).toEqual([['1', ''], ['2', 'A']]);
    expect(() => previewDataset('z.json', '{}')).toThrow(/array of objects/);
    expect(() => previewDataset('z.txt', '')).toThrow(/csv or .json/);
  });
});
