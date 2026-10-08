import { AssertionSchema, type Assertion } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  patternMatcher,
  runAssertion,
  StepCapture,
  summarizeAssertion,
  type AssertionContext,
  type AssertionResult,
} from './index.js';

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

async function fresh(path: string): Promise<Page> {
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  await page.goto(`${server.url}${path}`);
  return page;
}

/** Parses through the domain schema so defaults apply. */
function a(input: Record<string, unknown>): Assertion {
  return AssertionSchema.parse(input);
}

async function run(page: Page, input: Record<string, unknown>, ctx: AssertionContext = {}): Promise<AssertionResult> {
  return runAssertion(page, a(input), { timeoutMs: 400, ...ctx });
}

describe('patternMatcher', () => {
  it('handles globs and regexes', () => {
    expect(patternMatcher('/checkout/*')('/checkout/payment')).toBe(true);
    expect(patternMatcher('/checkout/*')('/checkout/a/b')).toBe(false);
    expect(patternMatcher('**/payment')('http://x/shop/checkout/payment')).toBe(true);
    expect(patternMatcher('/checkout/(pay|ship)')('/checkout/ship')).toBe(true);
    expect(patternMatcher('(')('a(b')).toBe(true);
  });
});

describe('summarizeAssertion', () => {
  it('matches the case editor wireframe forms', () => {
    expect(summarizeAssertion(a({ type: 'urlMatches', pattern: '/checkout/payment' }))).toBe('url ~ /checkout/payment');
    expect(summarizeAssertion(a({ type: 'elementText', role: 'status', contains: '1' }))).toBe('text(status) ⊇ "1"');
    expect(summarizeAssertion(a({ type: 'elementText', testId: 'total', equals: '9' }))).toBe('text(total) = "9"');
    expect(summarizeAssertion(a({ type: 'titleContains', contains: 'Shop' }))).toBe('title ⊇ "Shop"');
    expect(summarizeAssertion(a({ type: 'elementVisible', role: 'button', name: 'Pay now' }))).toBe(
      'visible(button "Pay now")',
    );
    expect(summarizeAssertion(a({ type: 'elementVisible', css: '.x', visible: false }))).toBe('hidden(.x)');
    expect(summarizeAssertion(a({ type: 'elementValue', css: '#q', equals: 'mug' }))).toBe('value(#q) = "mug"');
    expect(summarizeAssertion(a({ type: 'elementCount', role: 'listitem', min: 2 }))).toBe('count(listitem) ≥ 2');
    expect(summarizeAssertion(a({ type: 'responseStatus', urlPattern: '/api/save', status: 200 }))).toBe(
      'response ~ /api/save → 200',
    );
    expect(summarizeAssertion(a({ type: 'noConsoleErrors' }))).toBe('no console errors');
    expect(summarizeAssertion(a({ type: 'downloadExists', filenamePattern: '.csv' }))).toBe('download ~ .csv');
    expect(summarizeAssertion(a({ type: 'apiCheck', url: '/shop', status: 200 }))).toBe('api GET /shop → 200');
  });
});

describe('urlMatches', () => {
  it('passes with regex and glob', async () => {
    const page = await fresh('/shop/checkout/payment');
    expect((await run(page, { type: 'urlMatches', pattern: '/checkout/payment$' })).verdict).toBe('pass');
    expect((await run(page, { type: 'urlMatches', pattern: '/shop/checkout/*' })).verdict).toBe('pass');
  });
  it('fails with expected vs actual', async () => {
    const page = await fresh('/shop/checkout/shipping');
    const r = await run(page, { type: 'urlMatches', pattern: '/checkout/payment' });
    expect(r.verdict).toBe('fail');
    expect(r.message).toBe('expected url ~ /checkout/payment, got /shop/checkout/shipping');
  });
});

describe('titleContains', () => {
  it('pass and fail', async () => {
    const page = await fresh('/shop');
    expect((await run(page, { type: 'titleContains', contains: 'Shop' })).verdict).toBe('pass');
    const r = await run(page, { type: 'titleContains', contains: 'Nope' });
    expect(r.verdict).toBe('fail');
    expect(r.message).toContain('expected title ⊇ "Nope", got "');
  });
});

describe('elementVisible', () => {
  it('pass and fail', async () => {
    const page = await fresh('/shop/checkout/payment');
    expect((await run(page, { type: 'elementVisible', role: 'button', name: 'Pay now' })).verdict).toBe('pass');
    expect((await run(page, { type: 'elementVisible', role: 'button', name: 'Missing' , visible: false})).verdict).toBe('pass');
    const r = await run(page, { type: 'elementVisible', role: 'button', name: 'Missing' });
    expect(r.verdict).toBe('fail');
    expect(r.message).toBe('expected button "Missing" visible, got not visible');
  });
  it('fails clearly without a target', async () => {
    const page = await fresh('/shop');
    expect((await run(page, { type: 'elementVisible' })).message).toContain('no element target');
  });
});

describe('elementText', () => {
  it('contains / equals pass and fail', async () => {
    const page = await fresh('/shop/checkout/payment');
    expect((await run(page, { type: 'elementText', role: 'heading', contains: 'Pay' })).verdict).toBe('pass');
    expect((await run(page, { type: 'elementText', role: 'heading', equals: 'Payment' })).verdict).toBe('pass');
    const r = await run(page, { type: 'elementText', role: 'heading', equals: 'Shipping' });
    expect(r.verdict).toBe('fail');
    expect(r.message).toBe('expected text(heading) = "Shipping", got "Payment"');
    expect((await run(page, { type: 'elementText', role: 'heading' })).verdict).toBe('fail');
  });
  it('auto-waits for text to change', async () => {
    const page = await fresh('/shop/checkout/payment');
    await page.evaluate(() => setTimeout(() => { const h = document.querySelector('h1'); if (h) h.textContent = 'Done'; }, 300));
    const r = await runAssertion(page, a({ type: 'elementText', role: 'heading', equals: 'Done' }), { timeoutMs: 3000 });
    expect(r.verdict).toBe('pass');
  });
});

describe('elementValue', () => {
  it('pass and fail', async () => {
    const page = await fresh('/shop/checkout/payment');
    await page.getByLabel('Card number').fill('4242');
    expect((await run(page, { type: 'elementValue', css: '#card', equals: '4242' })).verdict).toBe('pass');
    const r = await run(page, { type: 'elementValue', css: '#card', equals: '0000' });
    expect(r.verdict).toBe('fail');
    expect(r.message).toBe('expected value(#card) = "0000", got "4242"');
  });
});

describe('elementCount', () => {
  it('equals / min / max pass and fail', async () => {
    const page = await fresh('/shop');
    const n = await page.getByRole('link').count();
    expect(n).toBeGreaterThan(1);
    expect((await run(page, { type: 'elementCount', role: 'link', equals: n })).verdict).toBe('pass');
    expect((await run(page, { type: 'elementCount', role: 'link', min: 1, max: n })).verdict).toBe('pass');
    const r = await run(page, { type: 'elementCount', role: 'link', equals: n + 5 });
    expect(r.verdict).toBe('fail');
    expect(r.message).toBe(`expected count(link) = ${n + 5}, got ${n}`);
    expect((await run(page, { type: 'elementCount', role: 'link', max: 0 })).verdict).toBe('fail');
  });
});

describe('responseStatus', () => {
  it('pass and fail using captured responses', async () => {
    const page = await fresh('/shop');
    const capture = StepCapture.start(page);
    await page.goto(`${server.url}/shop/cart`);
    await page.goto(`${server.url}/shop/missing-page`);
    capture.dispose();
    expect((await run(page, { type: 'responseStatus', urlPattern: '/shop/cart$', status: 200 }, { capture })).verdict).toBe('pass');
    expect((await run(page, { type: 'responseStatus', urlPattern: '/shop/missing-page', status: 404 }, { capture })).verdict).toBe('pass');
    const wrong = await run(page, { type: 'responseStatus', urlPattern: '/shop/cart$', status: 500 }, { capture });
    expect(wrong.message).toBe('expected response ~ /shop/cart$ → 500, got 200');
    const none = await run(page, { type: 'responseStatus', urlPattern: '/nothing', status: 200 }, { capture });
    expect(none.verdict).toBe('fail');
    expect(none.message).toContain('no matching response');
  });
});

describe('noConsoleErrors', () => {
  it('pass, fail and allow-list', async () => {
    const page = await fresh('/shop');
    const clean = StepCapture.start(page);
    expect((await run(page, { type: 'noConsoleErrors' }, { capture: clean })).verdict).toBe('pass');
    await page.evaluate(() => console.error('boom: widget failed'));
    await page.waitForTimeout(50);
    clean.dispose();
    const r = await run(page, { type: 'noConsoleErrors' }, { capture: clean });
    expect(r.verdict).toBe('fail');
    expect(r.message).toBe('expected no console errors, got 1 error(s): "boom: widget failed"');
    expect((await run(page, { type: 'noConsoleErrors', allow: ['widget failed'] }, { capture: clean })).verdict).toBe('pass');
  });
});

describe('downloadExists', () => {
  it('pass and fail', async () => {
    const page = await fresh('/shop');
    const capture = StepCapture.start(page);
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob(['a,b']));
      link.download = 'report.csv';
      document.body.append(link);
      link.click();
    });
    expect((await run(page, { type: 'downloadExists', filenamePattern: '\\.csv$' }, { capture, timeoutMs: 3000 })).verdict).toBe('pass');
    expect((await run(page, { type: 'downloadExists' }, { capture })).verdict).toBe('pass');
    const r = await run(page, { type: 'downloadExists', filenamePattern: '\\.pdf$' }, { capture });
    expect(r.verdict).toBe('fail');
    expect(r.message).toBe('expected download ~ \\.pdf$, got downloads "report.csv"');
    capture.dispose();
  });
});

describe('apiCheck', () => {
  it('pass and fail', async () => {
    const page = await fresh('/shop');
    expect((await run(page, { type: 'apiCheck', url: '/shop', status: 200, bodyContains: 'Fixture Shop' })).verdict).toBe('pass');
    expect((await run(page, { type: 'apiCheck', url: '/shop/missing-page', status: 404 })).verdict).toBe('pass');
    const r = await run(page, { type: 'apiCheck', url: '/shop/missing-page', status: 200 });
    expect(r.verdict).toBe('fail');
    expect(r.message).toBe('expected GET /shop/missing-page → 200, got status 404');
    const body = await run(page, { type: 'apiCheck', url: '/shop', bodyContains: 'zzz-not-there' });
    expect(body.verdict).toBe('fail');
    expect(body.message).toContain('expected GET /shop → 2xx with body ⊇ "zzz-not-there"');
  });
});
