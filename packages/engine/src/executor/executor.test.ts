import { readFile } from 'node:fs/promises';

import type { LocatorCandidate } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { captureElements } from '../observer/elements.js';
import type { ObservedElement } from '../observer/types.js';

import { execute, inferAction, type ExecutorContext } from './index.js';

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

async function fresh(): Promise<Page> {
  return (await browser.newContext()).newPage();
}

const SECRET = 'hunter2-s3cret';
const values: Record<string, string> = {
  'var:name': 'Ada Lovelace',
  'var:country': 'India',
  'secret:pw': SECRET,
};
const ctx: ExecutorContext = {
  resolveValue: (ref) => {
    const v = values[ref];
    if (v === undefined) throw new Error(`unknown ref ${ref}`);
    return v;
  },
  actionTimeoutMs: 1500,
};

/** Finds an observed element by role+name and returns its locator candidates. */
async function find(page: Page, role: string, name: string): Promise<ObservedElement> {
  const els = await captureElements(page);
  const el = els.find((e) => e.role === role && e.name === name);
  if (!el) throw new Error(`no ${role} "${name}" in: ${els.map((e) => `${e.role}:${e.name}`).join(', ')}`);
  return el;
}

describe('inferAction', () => {
  it('maps roles to actions', () => {
    expect(inferAction({ role: 'textbox' }, true)).toBe('fill');
    expect(inferAction({ role: 'searchbox' }, false)).toBe('fill');
    expect(inferAction({ role: 'combobox' }, true)).toBe('fill');
    expect(inferAction({ role: 'combobox' }, false)).toBe('click');
    expect(inferAction({ role: 'listbox' }, true)).toBe('selectOption');
    expect(inferAction({ role: 'checkbox' }, false)).toBe('check');
    expect(inferAction({ role: 'radio' }, false)).toBe('check');
    expect(inferAction({ role: 'switch' }, false)).toBe('check');
    expect(inferAction({ role: 'button' }, false)).toBe('click');
  });
});

describe('execute on fixture sites', () => {
  it('fills, selects, checks and clicks through the forms flow using observer locators', async () => {
    const page = await fresh();
    await page.goto(`${server.url}/forms`);

    const name = await find(page, 'textbox', 'Full name');
    const r1 = await execute(page, { kind: 'fill', locators: name.locators, valueRef: 'var:name' }, ctx);
    expect(r1).toMatchObject({ ok: true, valueRef: 'var:name' });
    expect(r1.usedLocator).toEqual(name.locators[0]);
    await expect(page.getByLabel('Full name').inputValue()).resolves.toBe('Ada Lovelace');

    // fill on a <select> falls back to selecting by label
    const country = await find(page, 'combobox', 'Country');
    expect(inferAction(country, true)).toBe('fill');
    const r2 = await execute(page, { kind: 'fill', locators: country.locators, valueRef: 'var:country' }, ctx);
    expect(r2.ok).toBe(true);
    await expect(page.getByLabel('Country').inputValue()).resolves.toBe('India');

    const r3 = await execute(page, { kind: 'selectOption', locators: country.locators, label: 'Germany' }, ctx);
    expect(r3.ok).toBe(true);
    await expect(page.getByLabel('Country').inputValue()).resolves.toBe('Germany');

    const terms = await find(page, 'checkbox', 'I accept the terms');
    expect((await execute(page, { kind: 'check', locators: terms.locators }, ctx)).ok).toBe(true);
    await expect(page.getByLabel('I accept the terms').isChecked()).resolves.toBe(true);
    expect((await execute(page, { kind: 'uncheck', locators: terms.locators }, ctx)).ok).toBe(true);
    await expect(page.getByLabel('I accept the terms').isChecked()).resolves.toBe(false);

    const phone = await find(page, 'radio', 'Phone');
    expect((await execute(page, { kind: 'check', locators: phone.locators }, ctx)).ok).toBe(true);
    await expect(page.getByLabel('Phone').isChecked()).resolves.toBe(true);

    const send = await find(page, 'button', 'Send');
    expect((await execute(page, { kind: 'hover', locators: send.locators }, ctx)).ok).toBe(true);
    expect((await execute(page, { kind: 'click', locators: send.locators }, ctx)).ok).toBe(true);
    await page.close();
  });

  it('navigates the shop with goto / click / goBack / press / scroll and reports navigation', async () => {
    const page = await fresh();
    const g = await execute(page, { kind: 'goto', url: `${server.url}/shop` }, ctx);
    expect(g.ok).toBe(true);
    expect(g.navigated).toBe(true);

    const els = await captureElements(page);
    const link = els.find((e) => e.role === 'link' && /classic tee/i.test(e.name));
    if (!link) throw new Error('no product link');
    const c = await execute(page, { kind: 'click', locators: link.locators }, ctx);
    expect(c).toMatchObject({ ok: true, navigated: true });
    expect(page.url()).toContain('/shop/product/');

    const b = await execute(page, { kind: 'goBack' }, ctx);
    expect(b).toMatchObject({ ok: true, navigated: true });
    expect(page.url()).toBe(`${server.url}/shop`);

    expect((await execute(page, { kind: 'press', key: 'Tab' }, ctx)).ok).toBe(true);
    await page.setViewportSize({ width: 600, height: 300 });
    await page.evaluate(() => {
      document.body.style.minHeight = '3000px';
    });
    expect((await execute(page, { kind: 'scroll', dir: 'bottom' }, ctx)).ok).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect((await execute(page, { kind: 'scroll', dir: 'top' }, ctx)).ok).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.close();
  });

  it('presses a key on a located element', async () => {
    const page = await fresh();
    await page.goto(`${server.url}/forms`);
    const name = await find(page, 'textbox', 'Full name');
    await execute(page, { kind: 'fill', locators: name.locators, valueRef: 'var:name' }, ctx);
    const r = await execute(page, { kind: 'press', key: 'Backspace', locators: name.locators }, ctx);
    expect(r.ok).toBe(true);
    await expect(page.getByLabel('Full name').inputValue()).resolves.toBe('Ada Lovelac');
    await page.close();
  });

  it('upload sets files from a resolved path', async () => {
    const page = await fresh();
    await page.setContent('<label for="f">Attachment</label><input id="f" type="file">');
    const el = await find(page, 'textbox', 'Attachment').catch(() => null);
    const locators: LocatorCandidate[] = el?.locators ?? [{ kind: 'css', value: '#f' }];
    const r = await execute(page, { kind: 'upload', locators, fileRef: 'var:file' }, {
      ...ctx,
      resolveValue: () => new URL(import.meta.url).pathname,
    });
    expect(r).toMatchObject({ ok: true, valueRef: 'var:file' });
    await expect(page.locator('#f').evaluate((i: HTMLInputElement) => i.files?.[0]?.name)).resolves.toBe(
      'executor.test.ts',
    );
    await page.close();
  });
});

describe('fallback and error handling', () => {
  it('skips a broken first candidate and records the one that worked', async () => {
    const page = await fresh();
    await page.goto(`${server.url}/forms`);
    const send = await find(page, 'button', 'Send');
    const broken: LocatorCandidate = { kind: 'testId', value: 'does-not-exist' };
    const r = await execute(page, { kind: 'click', locators: [broken, ...send.locators] }, ctx);
    expect(r.ok).toBe(true);
    expect(r.usedLocator).toEqual(send.locators[0]);
    await page.close();
  });

  it('retries once with the next candidate when the first times out', async () => {
    const page = await fresh();
    await page.setContent(`
      <button id="hidden" style="display:none">Go</button>
      <button id="real" onclick="document.title='clicked'">Go</button>`);
    const first: LocatorCandidate = { kind: 'css', value: '#hidden' };
    const second: LocatorCandidate = { kind: 'css', value: '#real' };
    const r = await execute(page, { kind: 'click', locators: [first, second] }, { ...ctx, actionTimeoutMs: 500 });
    expect(r.ok).toBe(true);
    expect(r.usedLocator).toEqual(second);
    expect(await page.title()).toBe('clicked');
    await page.close();
  });

  it('reports locator_not_found and timeout errors without throwing', async () => {
    const page = await fresh();
    await page.setContent('<button id="hidden" style="display:none">Go</button>');
    const none = await execute(page, { kind: 'click', locators: [{ kind: 'css', value: '#nope' }] }, ctx);
    expect(none).toMatchObject({ ok: false, error: { code: 'locator_not_found' } });
    const slow = await execute(
      page,
      { kind: 'click', locators: [{ kind: 'css', value: '#hidden' }] },
      { ...ctx, actionTimeoutMs: 300 },
    );
    expect(slow).toMatchObject({ ok: false, error: { code: 'timeout' } });
    await page.close();
  });

  it('never stores a secret in the outcome, even on failure', async () => {
    const page = await fresh();
    await page.setContent('<label for="pw">Password</label><input id="pw" type="password">');
    const pw: LocatorCandidate[] = [{ kind: 'css', value: '#pw' }];
    const ok = await execute(page, { kind: 'fill', locators: pw, valueRef: 'secret:pw' }, ctx);
    expect(ok.ok).toBe(true);
    expect(ok.valueRef).toBe('secret:pw');
    expect(JSON.stringify(ok, (k, v: unknown) => (k === 'page' ? undefined : v))).not.toContain(SECRET);
    await expect(page.locator('#pw').inputValue()).resolves.toBe(SECRET);

    // Failure path: field disabled -> fill times out; message must not echo the value.
    await page.evaluate(() => {
      (document.querySelector('#pw') as HTMLInputElement).disabled = true;
    });
    const bad = await execute(page, { kind: 'fill', locators: pw, valueRef: 'secret:pw' }, { ...ctx, actionTimeoutMs: 300 });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad, (k, v: unknown) => (k === 'page' ? undefined : v))).not.toContain(SECRET);
    await page.close();
  });

  it('reports missing_value when no resolver is given', async () => {
    const page = await fresh();
    await page.setContent('<input id="a">');
    const r = await execute(page, { kind: 'fill', locators: [{ kind: 'css', value: '#a' }], valueRef: 'var:x' });
    expect(r).toMatchObject({ ok: false, error: { code: 'missing_value' } });
    await page.close();
  });
});

describe('shop manual flow via execute()', () => {
  it('adds the tee to the cart and reaches guest checkout using only observer locators', async () => {
    const page = await fresh();
    await execute(page, { kind: 'goto', url: `${server.url}/shop/product/classic-tee` }, ctx);
    const blue = await find(page, 'radio', 'Blue');
    expect((await execute(page, { kind: 'check', locators: blue.locators }, ctx)).ok).toBe(true);
    const els = await captureElements(page);
    const size = els.find((e) => e.name === 'Size') ?? els.find((e) => e.role === 'radio' && e.name === 'M');
    if (!size) throw new Error('no size control');
    const r = await execute(
      page,
      size.role === 'radio'
        ? { kind: 'check', locators: size.locators }
        : { kind: 'selectOption', locators: size.locators, label: 'M' },
      ctx,
    );
    expect(r.ok).toBe(true);
    const add = await find(page, 'button', 'Add to cart');
    expect((await execute(page, { kind: 'click', locators: add.locators }, ctx)).ok).toBe(true);
    await execute(page, { kind: 'goto', url: `${server.url}/shop/cart` }, ctx);
    const checkout = await find(page, 'link', 'Checkout');
    expect((await execute(page, { kind: 'click', locators: checkout.locators }, ctx)).navigated).toBe(true);
    const guest = await find(page, 'button', 'Guest checkout');
    expect((await execute(page, { kind: 'click', locators: guest.locators }, ctx)).ok).toBe(true);
    await page.close();
  });
});

describe('popups, dialogs and downloads', () => {
  it('follows and reports a popup opened in a new tab', async () => {
    const page = await fresh();
    await page.goto(`${server.url}/forms`);
    await page.evaluate((url) => {
      document.body.insertAdjacentHTML('beforeend', `<a id="pop" href="${url}/shop" target="_blank">Open shop</a>`);
    }, server.url);
    const r = await execute(page, { kind: 'click', locators: [{ kind: 'css', value: '#pop' }] }, ctx);
    expect(r.ok).toBe(true);
    expect(r.newPage).toBeDefined();
    expect(r.newPage?.url).toBe(`${server.url}/shop`);
    expect(r.newPage?.page).not.toBe(page);
    // The caller can continue on the new page.
    const popup = r.newPage?.page;
    if (!popup) throw new Error('no popup');
    const els = await captureElements(popup);
    expect(els.some((e) => e.role === 'link')).toBe(true);
    await page.close();
  });

  it('auto-accepts dialogs and dismisses them when guarded', async () => {
    const page = await fresh();
    await page.setContent(`<button id="b" onclick="document.title = String(confirm('Sure?'))">Ask</button>`);
    const loc: LocatorCandidate[] = [{ kind: 'css', value: '#b' }];
    const accepted = await execute(page, { kind: 'click', locators: loc }, ctx);
    expect(accepted.dialog).toEqual({ type: 'confirm', message: 'Sure?', accepted: true });
    expect(await page.title()).toBe('true');
    const dismissed = await execute(page, { kind: 'click', locators: loc }, { ...ctx, guardDialogs: true });
    expect(dismissed.dialog).toEqual({ type: 'confirm', message: 'Sure?', accepted: false });
    expect(await page.title()).toBe('false');
    await page.close();
  });

  it('saves downloads and records the path', async () => {
    const page = await fresh();
    await page.setContent(`<a id="dl" href="data:text/plain;base64,aGVsbG8=" download="hello.txt">Get</a>`);
    const r = await execute(page, { kind: 'click', locators: [{ kind: 'css', value: '#dl' }] }, ctx);
    expect(r.ok).toBe(true);
    expect(r.download?.suggestedFilename).toBe('hello.txt');
    expect(await readFile(r.download?.path ?? '', 'utf8')).toBe('hello');
    await page.close();
  });
});
