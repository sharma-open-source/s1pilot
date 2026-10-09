import { expect as pw } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ObservedElement } from './types.js';

import { captureElements, captureTexts, indexElements, resolveFirstUnique, toPlaywrightLocator } from './index.js';

let browser: Browser;
let server: FixtureServer;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  server = await startFixtureServer();
});
afterAll(async () => {
  await browser.close();
  await server.close();
});

async function fresh(): Promise<Page> {
  const context = await browser.newContext();
  page = await context.newPage();
  return page;
}

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

/** Compact, box-free rendering of a capture for snapshots. */
function lines(els: ObservedElement[]): string {
  return els
    .map((e) => `${e.id} ${e.role} ${JSON.stringify(e.name)}${e.landmark ? ` @${e.landmark}` : ''}${e.frame ? ` [frame ${e.frame}]` : ''}`)
    .join('\n');
}

async function addTeeToCart(p: Page): Promise<void> {
  await p.goto(`${server.url}/shop/product/classic-tee`);
  await p.getByLabel('Blue').check();
  if ((await p.locator('select#size').count()) > 0) await p.getByLabel('Size').selectOption('M');
  else await p.getByLabel('M', { exact: true }).check();
  await p.getByRole('button', { name: 'Add to cart' }).click();
  await pw(p.getByRole('status')).toHaveText('1');
}

describe('captureElements on fixture sites', () => {
  it('finds the Guest checkout button on the shop cart->checkout flow with a unique role locator', async () => {
    const p = await fresh();
    await addTeeToCart(p);
    await p.goto(`${server.url}/shop/cart`);
    await p.getByRole('link', { name: 'Checkout', exact: true }).click();
    await pw(p.getByRole('button', { name: 'Guest checkout' })).toBeVisible();

    const els = await captureElements(p);
    const guest = els.filter((e) => e.name === 'Guest checkout');
    expect(guest).toHaveLength(1);
    const g = must(guest[0]);
    expect(g.role).toBe('button');
    expect(g.box.w).toBeGreaterThan(0);
    const roleCandidate = must(g.locators[0]);
    expect(roleCandidate).toMatchObject({ kind: 'role', value: 'button', name: 'Guest checkout' });
    await pw(toPlaywrightLocator(p, roleCandidate)).toHaveCount(1);
    const resolved = await resolveFirstUnique(p, g.locators);
    expect(resolved?.candidate.kind).toBe('role');
    // The locator really points at the same element the descriptor describes.
    const box = must(await must(resolved).locator.boundingBox());
    expect(Math.round(box.x)).toBe(g.box.x);
    expect(Math.round(box.y)).toBe(g.box.y);
    expect(indexElements(els).get(g.id)).toBe(g);
  });

  it('gives every captured element a locator that resolves uniquely (shop pages)', async () => {
    const p = await fresh();
    await addTeeToCart(p);
    for (const path of ['/shop', '/shop/product/classic-tee', '/shop/cart', '/shop/checkout', '/shop/login']) {
      await p.goto(`${server.url}${path}`);
      const els = await captureElements(p);
      expect(els.length).toBeGreaterThan(0);
      for (const e of els) {
        const resolved = await resolveFirstUnique(p, e.locators);
        expect(resolved, `${path} ${e.id} ${e.role} "${e.name}"`).not.toBeNull();
      }
    }
  });

  it('never exposes password values (nor masked placeholders of them)', async () => {
    const p = await fresh();
    await p.goto(`${server.url}/shop/login`);
    const pwd = p.locator('input[type=password]');
    await pwd.fill('hunter2-SECRET');
    const els = await captureElements(p);
    expect(JSON.stringify(els)).not.toContain('hunter2-SECRET');
    const field = els.find((e) => e.name.toLowerCase().includes('password'));
    expect(field).toBeDefined();
    expect(must(field).value).toBeUndefined();

    await p.setContent(`
      <label for="pw">Pass</label><input id="pw" type="password" value="abc123">
      <input aria-label="API token" name="api_token" value="tok_live_999">
      <input aria-label="City" value="Paris">`);
    const more = await captureElements(p);
    expect(JSON.stringify(more)).not.toContain('abc123');
    expect(JSON.stringify(more)).not.toContain('tok_live_999');
    expect(more.find((e) => e.name === 'City')?.value).toBe('Paris');
    expect(more.find((e) => e.name === 'Pass')?.value).toBeUndefined();
  });

  it('excludes hidden and disabled elements and tags dialog contents with dialog:<name>', async () => {
    const p = await fresh();
    await p.goto(`${server.url}/settings`);
    const before = await captureElements(p);
    expect(before.map((e) => e.name)).not.toContain('Delete my account'); // closed dialog is hidden
    expect(before.find((e) => e.name === 'Delete account')?.landmark).toBe('main');

    await p.getByRole('button', { name: 'Delete account' }).click();
    const open = await captureElements(p);
    const confirm = open.find((e) => e.name === 'Delete my account');
    expect(confirm?.landmark).toBe('dialog:Delete account?');
    expect(open.find((e) => e.name === 'Cancel')?.landmark).toBe('dialog:Delete account?');
    expect(open.find((e) => e.name === 'Display name')?.landmark).toBe('form');

    await p.setContent(`
      <button>Visible</button>
      <button disabled>Disabled</button>
      <button aria-disabled="true">Aria disabled</button>
      <button style="display:none">Display none</button>
      <button style="visibility:hidden">Visibility hidden</button>
      <div hidden><a href="/x">Hidden link</a></div>
      <button style="width:0;height:0;padding:0;border:0"></button>
      <fieldset disabled><input aria-label="In disabled fieldset"></fieldset>
      <div aria-hidden="true"><button>Aria hidden</button></div>`);
    expect((await captureElements(p)).map((e) => e.name)).toEqual(['Visible']);
  });

  it('captures state, shadow DOM, iframes and onclick heuristics', async () => {
    const p = await fresh();
    await p.setContent(`
      <label><input type="checkbox" checked> Subscribe</label>
      <button aria-expanded="false" data-testid="menu-btn">Menu</button>
      <div role="tab" aria-selected="true">Tab one</div>
      <div onclick="void 0">Clicky</div>
      <div id="host"></div>
      <iframe name="inner" style="width:300px;height:100px" srcdoc="<button>Inside frame</button>"></iframe>
      <script>
        const r = document.getElementById('host').attachShadow({mode:'open'});
        r.innerHTML = '<button>In shadow</button>';
      </script>`);
    await p.frameLocator('iframe').getByRole('button', { name: 'Inside frame' }).waitFor();
    const els = await captureElements(p);
    const by = (n: string) => must(els.find((e) => e.name === n));
    expect(by('Subscribe')).toMatchObject({ role: 'checkbox', state: { checked: true } });
    expect(by('Menu')).toMatchObject({ role: 'button', state: { expanded: false } });
    expect(by('Menu').locators.map((l) => l.kind)).toEqual(['role', 'testId', 'text', 'css']);
    expect(by('Tab one')).toMatchObject({ role: 'tab', state: { selected: true } });
    expect(by('Inside frame').frame).toBe('inner');
    expect(by('Inside frame').box.y).toBeGreaterThan(0);
    expect(by('In shadow').role).toBe('button');
    expect((await resolveFirstUnique(p, by('In shadow').locators))?.candidate.kind).toBe('role');
    const shadowCss = must(by('In shadow').locators.at(-1));
    await pw(toPlaywrightLocator(p, shadowCss)).toHaveCount(1);
    expect(els.some((e) => e.text === 'Clicky')).toBe(true);
    expect(els.map((e) => e.id)).toEqual(els.map((_, i) => `e${i + 1}`));
    const inFrame = must(p.frames().find((f) => f.name() === 'inner'));
    expect(await resolveFirstUnique(inFrame, by('Inside frame').locators)).not.toBeNull();
  });

  it('trims text to 120 chars and omits non-unique text locators', async () => {
    const p = await fresh();
    await p.setContent(`<a href="#a">${'x'.repeat(300)}</a><button>Go</button><button>Go</button>`);
    const els = await captureElements(p);
    expect(must(els[0]).text).toHaveLength(120);
    expect(must(els[0]).locators.some((l) => l.kind === 'text')).toBe(false);
    expect(must(els[1]).locators.some((l) => l.kind === 'text')).toBe(false);
    expect(await resolveFirstUnique(p, must(els[1]).locators)).toMatchObject({ candidate: { kind: 'css' } });
  });

  it('captures a 200-element page in under 500 ms', async () => {
    const p = await fresh();
    const items = Array.from({ length: 200 }, (_, i) => {
      switch (i % 4) {
        case 0:
          return `<button id="b${i}">Button ${i}</button>`;
        case 1:
          return `<a href="/p/${i}">Link ${i}</a>`;
        case 2:
          return `<label>Field ${i} <input name="f${i}" value="v${i}"></label>`;
        default:
          return `<div role="checkbox" aria-checked="false" tabindex="0">Option ${i}</div>`;
      }
    });
    await p.setContent(`<main><ul>${items.map((h) => `<li>${h}</li>`).join('')}</ul></main>`);
    await captureElements(p); // warm-up (JIT, CDP session)
    const runs: number[] = [];
    let els: ObservedElement[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      els = await captureElements(p);
      runs.push(performance.now() - t0);
    }
    expect(els).toHaveLength(200);
    // Best of 5 warm runs, wall-clock incl. the CDP round trip, headless Chromium.
    expect(Math.min(...runs)).toBeLessThan(500);
  });
});

describe('descriptor snapshots per fixture site', () => {
  const targets: { name: string; path: string }[] = [
    { name: 'shop home', path: '/shop' },
    { name: 'shop product', path: '/shop/product/classic-tee' },
    { name: 'shop cart (empty)', path: '/shop/cart' },
    { name: 'shop login', path: '/shop/login' },
    { name: 'settings', path: '/settings' },
    { name: 'forms', path: '/forms' },
    { name: 'mail', path: '/mail' },
  ];
  for (const t of targets) {
    it(`${t.name}`, async () => {
      const p = await fresh();
      await p.goto(`${server.url}${t.path}`);
      expect(lines(await captureElements(p))).toMatchSnapshot();
    });
  }

  it('shop checkout (cart with item)', async () => {
    const p = await fresh();
    await addTeeToCart(p);
    await p.goto(`${server.url}/shop/checkout`);
    expect(lines(await captureElements(p))).toMatchSnapshot();
  });
});

describe('captureTexts', () => {
  it('captures visible non-interactive text blocks, in view or not, without control text', async () => {
    const p = await fresh();
    await p.setContent(`
      <main>
        <h2>Customer reviews</h2>
        <p>Get <b>free</b> shipping on orders over $50</p>
        <p>Read our <a href="#t">terms</a> first</p>
        <label for="q">Search</label><input id="q">
        <button>Buy <span>now</span></button>
        <div id="promo" style="cursor:pointer">Show promo</div>
        <p aria-hidden="true">Hidden note</p>
        <p style="display:none">Gone</p>
        <div style="height:3000px"></div>
        <p>Terms and conditions apply</p>
      </main>
      <script>document.getElementById('promo').addEventListener('click', () => { document.title = 'clicked'; });</script>`);

    const texts = await captureTexts(p);
    expect(texts.map((t) => `${t.id} ${t.role} ${JSON.stringify(t.name)}${t.clickable ? ' clickable' : ''}${t.inView === false ? ' offscreen' : ''}`)).toEqual([
      't1 heading "Customer reviews"',
      't2 text "Get free shipping on orders over $50"',
      't3 text "Read our terms first"',
      't4 text "Show promo" clickable',
      't5 text "Terms and conditions apply" offscreen',
    ]);
    expect(texts[0]?.locators[0]).toEqual({ kind: 'role', value: 'heading', name: 'Customer reviews' });
    expect(texts[0]?.landmark).toBe('main');
    for (const t of texts) {
      const hit = await resolveFirstUnique(p, t.locators);
      expect(hit, t.name).not.toBeNull();
    }
  });
});
