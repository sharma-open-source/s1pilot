import { describe, expect, it } from 'vitest';

import { paramHints, paramsError, parseParams, placeholdersIn, usageLines, usageTotal } from './model';

describe('shared-step model', () => {
  it('collects {placeholders} from action, expected and args', () => {
    expect(placeholdersIn([{ action: 'Log in as {role}', expected: 'Hello {role} {name}' }, { action: 'Run flow x', args: { who: '{user}' } }])).toEqual(['role', 'name', 'user']);
  });

  it('parses and validates the parameter field', () => {
    expect(parseParams(' role, {password} ,, ')).toEqual(['role', 'password']);
    expect(paramsError(['role', 'two words'])).toMatch(/"two words" is not a valid parameter/);
    expect(paramsError(['a', 'a'])).toMatch(/listed twice/);
    expect(paramsError(['a', 'b-c', '_d'])).toBeNull();
  });

  it('hints at unused and undeclared parameters', () => {
    const hints = paramHints(['role', 'spare'], [{ action: 'Log in as {role} with {password}' }]);
    expect(hints[0]).toBe('Not used in any step: {spare}.');
    expect(hints[1]).toMatch(/^\{password\} is not a parameter of this shared step/);
    expect(paramHints(['role'], [{ action: 'Log in as {role}' }])).toEqual([]);
  });

  it('summarises usage', () => {
    const u = { steps: ['T-1'], preconditions: [], flows: ['outer'], logins: ['staging / admin'] };
    expect(usageTotal(u)).toBe(3);
    expect(usageLines(u).map((l) => l.label)).toEqual(['Steps in test cases', 'Other shared steps', 'Environment logins']);
  });
});
