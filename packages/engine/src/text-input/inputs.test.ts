import { S1PilotError } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockChatModel, MockDecisionModel, type MockResolver } from '@s1pilot/providers';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HUMAN_UNAVAILABLE, type HumanHook } from '../decide/human.js';
import { captureElements } from '../observer/elements.js';

import { NONE_FITS, quotedValue, resolveInput, type InputVars } from './inputs.js';
import { createLiteralStore, createValueResolver } from './literals.js';

const PASSWORD = 'hunter2-s3cret-pw';

function makeVars(entries: Record<string, { value: string; secret?: boolean }>): InputVars & {
  get(key: string): string | undefined;
} {
  return {
    keys: () => Object.keys(entries),
    isSecret: (k) => entries[k]?.secret === true,
    secretValues: () => Object.values(entries).filter((e) => e.secret).map((e) => e.value),
    get: (k) => entries[k]?.value,
  };
}

const vars = makeVars({
  shipping_name: { value: 'Ada Lovelace' },
  shipping_zip: { value: '94107' },
  customer_password: { value: PASSWORD, secret: true },
});

/** Picks the option whose key shares a word with the field label; `none_fits` otherwise. */
const byKeyword: MockResolver = (question) => {
  if (question.type !== 'choice') return { noul: 0.5 };
  const text = question.instructions.toLowerCase();
  const keys = Object.keys(question.criteria);
  const hit = keys.find((k) =>
    k
      .replace(/^[a-z]+:/, '')
      .split('_')
      .some((w) => w.length > 2 && w !== 'shipping' && text.includes(w)),
  );
  return { choice: hit ?? NONE_FITS };
};

const noneFits: MockResolver = () => ({ choice: NONE_FITS });

describe('resolveInput (unit)', () => {
  const el = { role: 'textbox', name: 'Full name', placeholder: 'Jane Doe' };

  it('returns the chosen key as a value ref', async () => {
    const s1 = new MockDecisionModel({ fallback: byKeyword });
    expect(await resolveInput({ element: el, step: { text: 'enter name' }, vars, s1 })).toEqual({
      valueRef: 'var:shipping_name',
    });
  });

  it('restricts candidates to step inputs', async () => {
    const s1 = new MockDecisionModel({ fallback: byKeyword });
    await resolveInput({ element: el, step: { text: 'x', inputs: ['shipping_zip'] }, vars, s1 });
    const criteria = (s1.calls[0]?.request.questions.input_key as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria)).toEqual(['var:shipping_zip', NONE_FITS]);
  });

  it('supports parameters', async () => {
    const s1 = new MockDecisionModel({ fallback: () => ({ choice: 'param:size' }) });
    const r = await resolveInput({ element: el, step: { text: 'x' }, vars, params: { size: 'M' }, s1 });
    expect(r).toEqual({ valueRef: 'param:size' });
  });

  it('uses a value quoted in the step as a stable text: ref, without asking a model', async () => {
    const s1 = new MockDecisionModel({ fallback: byKeyword });
    const r = await resolveInput({ element: el, step: { text: 'Type "Grace Hopper" in the name box' }, vars, s1 });
    expect(r).toEqual({ literal: 'Grace Hopper', source: 'step', valueRef: 'text:Grace Hopper' });
    expect(s1.calls).toHaveLength(0);
    expect(createValueResolver({ vars })('text:Grace Hopper')).toBe('Grace Hopper');
  });

  it('prefers bound step inputs over a quoted value', async () => {
    const s1 = new MockDecisionModel({ fallback: () => ({ choice: 'var:shipping_name' }) });
    const r = await resolveInput({ element: el, step: { text: 'Type "Grace" as name', inputs: ['shipping_name'] }, vars, s1 });
    expect(r).toEqual({ valueRef: 'var:shipping_name' });
  });

  it('quotedValue finds exactly one quoted value', () => {
    expect(quotedValue('Type "JavaScript" in the search box')).toBe('JavaScript');
    expect(quotedValue('Type \u201cjs\u201d here')).toBe('js');
    expect(quotedValue('Type "js" again: "js"')).toBe('js');
    expect(quotedValue('Type "js" and pick "JavaScript"')).toBeUndefined();
    expect(quotedValue("enter the user's name")).toBeUndefined();
    expect(quotedValue('Type "" here')).toBeUndefined();
  });

  it('none_fits goes to S2 and stores a literal', async () => {
    const s1 = new MockDecisionModel({ fallback: noneFits });
    const s2 = new MockChatModel({ replies: ['{"value": "Grace Hopper"}'] });
    const literals = createLiteralStore();
    const r = await resolveInput({ element: el, step: { text: 'enter a name' }, vars, s1, s2, literals });
    expect(r).toMatchObject({ literal: 'Grace Hopper', source: 's2' });
    const ref = (r as { valueRef: string }).valueRef;
    expect(ref).toMatch(/^literal:[0-9a-f]{12}$/);
    expect(createValueResolver({ vars, literals })(ref)).toBe('Grace Hopper');
  });

  it('falls back to human, then to none', async () => {
    const s1 = new MockDecisionModel({ fallback: noneFits });
    const human: HumanHook = { ask: async () => ({ choice: 'typed by human' }) };
    expect(await resolveInput({ element: el, step: { text: 'x' }, vars, s1, human })).toMatchObject({
      literal: 'typed by human',
      source: 'human',
    });
    const unavailable: HumanHook = {
      ask: async () => {
        throw new S1PilotError(HUMAN_UNAVAILABLE, 'no tty');
      },
    };
    expect(await resolveInput({ element: el, step: { text: 'x' }, vars, s1, human: unavailable })).toEqual({ none: true });
    expect(await resolveInput({ element: el, step: { text: 'x' }, vars, s1 })).toEqual({ none: true });
  });

  it('never sends password fields to S2', async () => {
    const s1 = new MockDecisionModel({ fallback: noneFits });
    const s2 = new MockChatModel({ replies: ['{"value": "oops"}'] });
    const r = await resolveInput({
      element: { role: 'textbox', name: 'Password' },
      step: { text: 'enter the password' },
      vars,
      s1,
      s2,
    });
    expect(r).toEqual({ none: true });
    expect(s2.chatCalls).toHaveLength(0);
    expect(s2.pickCalls).toHaveLength(0);
  });

  it('never leaks secret values into S1 or S2 payloads', async () => {
    const s1 = new MockDecisionModel({ fallback: noneFits });
    const s2 = new MockChatModel({ replies: ['{"value": "x"}'] });
    await resolveInput({
      element: { role: 'textbox', name: 'Nickname' },
      step: { text: `type nickname (note: ${PASSWORD})` },
      vars,
      s1,
      s2,
    });
    // The key name is offered, the value is not.
    expect(JSON.stringify(s1.calls)).toContain('customer_password');
    expect(JSON.stringify(s1.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(s2.chatCalls)).not.toContain(PASSWORD);
  });
});

describe('resolveInput (shipping form fixture)', () => {
  let browser: Browser;
  let server: FixtureServer;
  beforeAll(async () => {
    browser = await chromium.launch();
    server = await startFixtureServer();
  });
  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it('resolves name and zip fields to var:shipping_name and var:shipping_zip', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${server.url}/shop/checkout/shipping`);
    const els = await captureElements(page);
    const s1 = new MockDecisionModel({ fallback: byKeyword });
    const resolved: Record<string, unknown> = {};
    for (const e of els.filter((x) => x.role === 'textbox')) {
      resolved[e.name] = await resolveInput({ element: e, step: { text: 'Fill in the shipping form' }, vars, s1 });
    }
    expect(resolved['Full name']).toEqual({ valueRef: 'var:shipping_name' });
    expect(resolved['ZIP code']).toEqual({ valueRef: 'var:shipping_zip' });
    expect(JSON.stringify(s1.calls)).not.toContain(PASSWORD);
  });
});
