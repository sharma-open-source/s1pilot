import { TestCaseSchema, type SharedStep, type TestCase } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { expandCase } from './parameters.js';
import { flowReference, inlineSharedSteps, resolvePreconditions, type FlowLookup } from './shared.js';

function makeCase(over: Record<string, unknown> = {}): TestCase {
  return TestCaseSchema.parse({
    id: 'c1',
    projectId: 'p1',
    key: 'SHOP-TC-42',
    title: 'Checkout',
    priority: 'P2',
    type: 'e2e',
    status: 'ready',
    steps: [
      { action: 'Choose colour {colour} and size {size}', expected: 'Cart shows {colour}', inputs: ['param:size'] },
      { action: 'Checkout' },
    ],
    ...over,
  });
}

function flow(name: string, params: string[], steps: { action: string; sharedStepId?: string; args?: Record<string, string> }[]): SharedStep {
  return { id: name, projectId: 'p1', name, params, steps: steps.map((s) => ({ assert: [], inputs: [], ...s })) };
}

const flows: Record<string, SharedStep> = {
  'clear-cart': flow('clear-cart', [], [{ action: 'Open the cart' }, { action: 'Remove every item' }]),
  login: flow('login', ['user'], [{ action: 'Log in as {user}' }]),
  outer: flow('outer', [], [{ action: 'Run flow login', sharedStepId: 'login', args: { user: 'ann' } }, { action: 'Done' }]),
  loop: flow('loop', [], [{ action: 'Run flow loop', sharedStepId: 'loop', args: {} }]),
};
const lookup: FlowLookup = (n) => flows[n];

describe('expandCase', () => {
  it('yields one instance per parameter row labelled by its values', () => {
    const rows = expandCase(makeCase({ parameters: [{ colour: 'blue', size: 'M' }, { colour: 'black', size: 'L' }] }));
    expect(rows.map((r) => r.label)).toEqual(['blue / M', 'black / L']);
    expect(rows.map((r) => r.count)).toEqual([2, 2]);
    expect(rows[1]?.testCase.steps[0]).toMatchObject({
      action: 'Choose colour black and size L',
      expected: 'Cart shows black',
      inputs: ['param:size'],
    });
    expect(rows[0]?.params).toEqual({ colour: 'blue', size: 'M' });
  });

  it('yields a single unlabelled instance without parameters', () => {
    const [only, ...rest] = expandCase(makeCase());
    expect(rest).toEqual([]);
    expect(only?.label).toBe('');
    expect(only?.testCase.steps[0]?.action).toBe('Choose colour {colour} and size {size}');
  });

  it('expands dataset rows, merging extra row keys', () => {
    const datasets = (n: string) => (n === 'addresses.csv' ? [{ colour: 'red', size: 'S' }, { colour: 'green', size: 'XL' }] : undefined);
    const rows = expandCase(makeCase({ parameters: [{ dataset: 'addresses.csv', size: 'M' }] }), { datasets });
    expect(rows.map((r) => r.label)).toEqual(['red / M', 'green / M']);
    expect(() => expandCase(makeCase({ parameters: [{ dataset: 'nope.csv' }] }), { datasets })).toThrow(/not found/);
    expect(() => expandCase(makeCase({ parameters: [{ dataset: 'e.csv' }] }), { datasets: () => [] })).toThrow(/no rows/);
  });

  it('shares a script key when bound steps are identical, splits it when actions differ', () => {
    const viaInput = makeCase({
      steps: [{ action: 'Pick the size from the list', inputs: ['param:size'] }],
      parameters: [{ size: 'M' }, { size: 'L' }],
    });
    const [a, b] = expandCase(viaInput);
    expect(a?.scriptKey).toBe(b?.scriptKey);
    const [c, d] = expandCase(makeCase({ parameters: [{ colour: 'blue', size: 'M' }, { colour: 'black', size: 'L' }] }));
    expect(c?.scriptKey).not.toBe(d?.scriptKey);
  });

  it('inlines flow preconditions ahead of the steps', () => {
    const [inst] = expandCase(makeCase({ preconditions: [{ flow: 'clear-cart' }] }), { flows: lookup });
    expect(inst?.preconditionSteps.map((s) => s.action)).toEqual(['Open the cart', 'Remove every item']);
    expect(inst?.preconditionSteps.every((s) => s.sharedStepId === 'clear-cart')).toBe(true);
  });
});

describe('inlineSharedSteps', () => {
  it('substitutes args and keeps sharedStepId on every inlined step', () => {
    const out = inlineSharedSteps(
      [{ action: 'Open', assert: [], inputs: [] }, { ...flowReference('login', { user: 'bob' }) }],
      lookup,
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ action: 'Log in as bob', sharedStepId: 'login' });
    expect(out[0]?.sharedStepId).toBeUndefined();
  });

  it('expands nested flows and keeps the innermost shared step id', () => {
    const out = inlineSharedSteps([flowReference('outer')], lookup);
    expect(out.map((s) => [s.action, s.sharedStepId])).toEqual([
      ['Log in as ann', 'login'],
      ['Done', 'outer'],
    ]);
  });

  it('rejects missing args, unknown flows and cycles', () => {
    expect(() => inlineSharedSteps([flowReference('login')], lookup)).toThrow(/needs argument/);
    expect(() => inlineSharedSteps([flowReference('ghost')], lookup)).toThrow(/not found/);
    expect(() => inlineSharedSteps([flowReference('loop')], lookup)).toThrow(/includes itself/);
  });

  it('lets case parameters fill flow args written as placeholders', () => {
    const [inst] = expandCase(makeCase({ steps: [{ action: 'Run flow login', sharedStepId: 'login', args: { user: '{colour}' } }], parameters: [{ colour: 'ann' }] }), { flows: lookup });
    expect(inst?.testCase.steps[0]?.action).toBe('Log in as ann');
  });
});

describe('resolvePreconditions', () => {
  it('splits flow and auth preconditions', () => {
    const r = resolvePreconditions({ preconditions: [{ auth: 'admin' }, { flow: 'clear-cart' }] }, lookup);
    expect(r.auth).toEqual(['admin']);
    expect(r.steps).toHaveLength(2);
  });
});
