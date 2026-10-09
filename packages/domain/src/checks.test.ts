import { describe, expect, it } from 'vitest';

import { checkConfigFromPlan, hasCheckWarnings, impactAtLeast, matchesAllowList, summarizeChecks } from './checks.js';

const plan = { a11y: false, consoleErrors: false, visual: false, video: false };

describe('checks', () => {
  it('orders impacts', () => {
    expect(impactAtLeast('critical', 'serious')).toBe(true);
    expect(impactAtLeast('serious', 'serious')).toBe(true);
    expect(impactAtLeast('moderate', 'serious')).toBe(false);
  });

  it('derives the runner config from the plan checks', () => {
    expect(checkConfigFromPlan(plan).a11y).toBeUndefined();
    expect(checkConfigFromPlan(plan).console.mode).toBe('warn');
    const on = checkConfigFromPlan({ ...plan, a11y: true, consoleErrors: true, a11yDisabledRules: ['region'], consoleAllow: ['ads'] });
    expect(on.a11y).toEqual({ failImpact: 'serious', disabledRules: ['region'] });
    expect(on.console.mode).toBe('fail');
    expect(on.network.mode).toBe('fail');
    expect(on.console.allow).toContain('ads');
    expect(on.network.thirdParty).toBe(false);
  });

  it('matches allow-list regexes case-insensitively and ignores invalid ones', () => {
    expect(matchesAllowList('GET https://x.test/Ads/1', ['/ads/'])).toBe(true);
    expect(matchesAllowList('anything', ['('])).toBe(false);
  });

  it('summarises results', () => {
    const results = [
      { kind: 'a11y' as const, severity: 'warn' as const, items: [] },
      { kind: 'console' as const, severity: 'pass' as const, items: [] },
    ];
    expect(summarizeChecks(results)).toEqual([
      { kind: 'a11y', severity: 'warn', count: 0 },
      { kind: 'console', severity: 'pass', count: 0 },
    ]);
    expect(hasCheckWarnings(results)).toBe(true);
    expect(hasCheckWarnings(undefined)).toBe(false);
  });
});
