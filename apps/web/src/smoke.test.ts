// @vitest-environment node
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Locator } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Concrete URL for every route in src/routes (see design.md section 5). */
const ROUTES: Array<[path: string, h1: string]> = [
  ['/', 'Dashboard'],
  ['/projects/new', 'Create project'],
  ['/p/shop/environments', 'Environments'],
  ['/p/shop/environments/staging', 'Environments'],
  ['/p/shop/cases', 'Test cases'],
  ['/p/shop/cases/SHOP-TC-42', 'Test case'],
  ['/p/shop/cases/SHOP-TC-42/yaml', 'Test case'],
  ['/p/shop/plans', 'Test plans'],
  ['/p/shop/plans/pl1', 'Test plan'],
  ['/p/shop/runs', 'Runs'],
  ['/p/shop/runs/r1', 'Run report'],
  ['/p/shop/runs/r1/live', 'Live run'],
  ['/p/shop/manual', 'Manual testing'],
  ['/p/shop/manual/s1', 'Manual run'],
  ['/p/shop/reports', 'Reports'],
  ['/p/shop/review', 'Review queue'],
  ['/p/shop/defects', 'Defects'],
  ['/p/shop/analytics/quality', 'Analytics'],
  ['/settings/general', 'Settings'],
  ['/_dev/components', 'Components'],
  ['/nope/nothing', 'Page not found'],
];

async function box(l: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await l.boundingBox();
  if (b === null) throw new Error('element not visible');
  return b;
}

let server: ViteDevServer;
let browser: Browser;
let base = '';

beforeAll(async () => {
  server = await createServer({ root: ROOT, server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  const addr = server.httpServer?.address();
  if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('route smoke (headless Chromium)', () => {
  for (const width of [1440, 400]) {
    it(`opens every route at ${width}px without horizontal scroll or console errors`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        // API calls are expected to fail (no server behind the dev proxy).
        if (m.type() === 'error' && !/Failed to load resource|WebSocket|ECONNREFUSED/.test(m.text())) errors.push(m.text());
      });
      for (const [path, h1] of ROUTES) {
        await page.goto(base + path, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { level: 1, name: h1 }).waitFor({ timeout: 15_000 });
        await page.getByRole('navigation', { name: 'Main' }).waitFor();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${path} at ${width}px`).toBeLessThanOrEqual(0);
      }
      expect(errors).toEqual([]);
      await page.close();
    }, 120_000);
  }

  it('redirects bare section routes', async () => {
    const page = await browser.newPage();
    await page.goto(`${base}/settings`);
    await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor();
    expect(new URL(page.url()).pathname).toBe('/settings/general');
    await page.goto(`${base}/p/shop/analytics`);
    await page.getByRole('heading', { level: 1, name: 'Analytics' }).waitFor();
    expect(new URL(page.url()).pathname).toBe('/p/shop/analytics/quality');
    await page.close();
  });

  it('stacks the nav above content at 400px and beside it at 1440px', async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
    await page.goto(`${base}/`);
    const nav = page.getByRole('navigation', { name: 'Main' });
    const main = page.getByRole('main');
    await main.waitFor();
    const n = await box(nav);
    const m = await box(main);
    expect(m.y).toBeGreaterThanOrEqual(n.y + n.height - 1);
    await page.setViewportSize({ width: 1440, height: 900 });
    const n2 = await box(nav);
    const m2 = await box(main);
    expect(m2.x).toBeGreaterThanOrEqual(n2.x + n2.width - 1);
    expect(n2.width).toBeGreaterThanOrEqual(220);
    expect(n2.width).toBeLessThanOrEqual(260);
    expect(await nav.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page');
    await page.close();
  });
});
