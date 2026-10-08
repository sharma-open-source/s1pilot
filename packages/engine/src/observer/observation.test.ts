import { createRedactor } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ActionHistory, observer, pageFingerprint, serializeObservation } from './index.js';

let browser: Browser;
let server: FixtureServer;
const extra: FixtureServer[] = [];

beforeAll(async () => {
  browser = await chromium.launch();
  server = await startFixtureServer();
});
afterAll(async () => {
  await browser.close();
  await server.close();
  await Promise.all(extra.map((s) => s.close()));
});

async function fresh(): Promise<Page> {
  return (await browser.newContext()).newPage();
}

const noop = createRedactor({ secrets: [], patterns: [], builtins: false });

/** Reads width/height from a PNG IHDR chunk. */
function pngSize(png: Buffer): { w: number; h: number } {
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

async function toCheckout(p: Page, base: string): Promise<void> {
  await p.goto(`${base}/shop/product/classic-tee`);
  await p.getByLabel('Blue').check();
  if ((await p.locator('select#size').count()) > 0) await p.getByLabel('Size').selectOption('M');
  else await p.getByLabel('M', { exact: true }).check();
  await p.getByRole('button', { name: 'Add to cart' }).click();
  await p.getByRole('status').filter({ hasText: '1' }).waitFor();
  await p.goto(`${base}/shop/cart`);
}

describe('ActionHistory', () => {
  it('keeps only the last K entries', () => {
    const h = new ActionHistory(3);
    for (let i = 0; i < 5; i++) h.push({ stepIndex: i, action: 'click', target: `b${i}`, result: 'ok' });
    expect(h.recent().map((e) => e.stepIndex)).toEqual([2, 3, 4]);
    expect(new ActionHistory().capacity).toBe(5);
  });
});

describe('observer.capture + serializeObservation', () => {
  it('serialises the /shop cart in < 4 KB with every interactive element line', async () => {
    const p = await fresh();
    await toCheckout(p, server.url);
    const history = new ActionHistory();
    history.push({ stepIndex: 1, action: 'click', target: 'Add to cart', result: 'ok' });
    const obs = await observer.capture(p, { history });
    expect(obs.som).toBeUndefined();
    const text = serializeObservation(obs, { redactor: noop });
    expect(Buffer.byteLength(text)).toBeLessThan(4096);
    for (const e of obs.elements) expect(text).toContain(`${e.id} [${e.role}] ${JSON.stringify(e.name)}`);
    expect(obs.elements.length).toBeGreaterThan(0);
    expect(text).toContain('recent actions:');
    expect(text).toMatch(/headings: /);
    expect(text.replace(/127\.0\.0\.1:\d+/g, 'HOST')).toMatchSnapshot();
  });

  it('honours maxElements', async () => {
    const p = await fresh();
    await p.goto(`${server.url}/shop`);
    const obs = await observer.capture(p);
    const text = serializeObservation(obs, { redactor: noop, maxElements: 2 });
    expect(text).toContain('e2 ');
    expect(text).not.toContain('\ne3 ');
    expect(text).toMatch(/more elements omitted/);
  });

  it('captures alerts, dialogs and validation messages', async () => {
    const p = await fresh();
    await p.setContent(`<title>T</title><h1>Hi</h1>
      <div role="alert">Saved!</div><div role="dialog" aria-label="Confirm"><button>OK</button></div>
      <label for="em">Email</label><input id="em" aria-invalid="true" aria-describedby="m"><span id="m">Enter a valid email</span>`);
    const obs = await observer.capture(p);
    expect(obs.context).toMatchObject({
      title: 'T',
      headings: ['Hi'],
      alerts: ['Saved!'],
      dialogs: ['Confirm'],
      validation: [{ field: 'Email', message: 'Enter a valid email' }],
    });
  });

  it('applies the redactor to all text before serialisation', async () => {
    const p = await fresh();
    const secret = 'hunter2-s3cr3t-value';
    await p.setContent(`<title>Account ${secret}</title><h1>Welcome ${secret}</h1>
      <div role="alert">Token ${secret} expired</div><button>Reveal ${secret}</button>`);
    const redactor = createRedactor({ secrets: [secret], patterns: [] });
    const history = new ActionHistory();
    history.push({ stepIndex: 0, action: 'fill', target: secret, result: `typed ${secret}` });
    const obs = await observer.capture(p, { history });
    const text = serializeObservation(obs, { redactor });
    expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED]');
  });

  it('produces a SoM PNG <= 448 px and leaves the DOM untouched', async () => {
    const p = await fresh();
    await p.goto(`${server.url}/shop`);
    const before = await p.content();
    const obs = await observer.capture(p, { som: true, supportsImages: true, allowImages: true });
    expect(obs.som).toBeDefined();
    const som = obs.som;
    if (!som) throw new Error('expected som');
    const { w, h } = pngSize(som.png);
    expect(Math.max(w, h)).toBeLessThanOrEqual(448);
    expect({ w, h }).toEqual({ w: som.width, h: som.height });
    expect(await p.content()).toBe(before);
    expect(await p.locator('[data-s1pilot-som]').count()).toBe(0);
    expect(p.context().pages()).toHaveLength(1);
  });

  it('skips the screenshot unless the model supports images and policy allows it', async () => {
    const p = await fresh();
    await p.goto(`${server.url}/shop`);
    expect((await observer.capture(p, { som: true, supportsImages: false, allowImages: true })).som).toBeUndefined();
    expect((await observer.capture(p, { som: true, supportsImages: true, allowImages: false })).som).toBeUndefined();
  });
});

describe('pageFingerprint', () => {
  it('is stable across loads and changes with variant shop.guest-button-renamed', async () => {
    const p = await fresh();
    const fp = async (base: string): Promise<string> => {
      await p.goto(`${base}/shop/checkout`);
      return pageFingerprint(await observer.capture(p));
    };
    const a = await fp(server.url);
    const b = await fp(server.url);
    expect(a).toBe(b);
    const renamed = await startFixtureServer({ variant: 'shop.guest-button-renamed' });
    extra.push(renamed);
    const c = await fp(renamed.url);
    expect(c).not.toBe(a);
  });
});
