// @vitest-environment node
import { mkdirSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeTrpc } from '../../test/fake-trpc';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SHOTS = process.env['CASES_SHOTS_DIR'];

const mk = (n: number, tags: string[], suiteId: string | undefined, over: Record<string, unknown> = {}) => ({
  id: `c${n}`,
  key: `SHOP-TC-${n}`,
  title: `Seeded case number ${n} with a reasonably long title`,
  priority: n % 2 === 0 ? 'P2' : 'P1',
  status: 'ready',
  tags,
  suiteId,
  stepCount: 3,
  suitePath: [],
  learned: [{ environmentId: 'e1', environmentName: 'staging', status: 'current' }],
  lastResult: { runId: 'r1', verdict: n % 3 === 0 ? 'failed' : 'passed', mode: 'replay', caseVersion: 1, durationMs: 5 },
  ...over,
});
const CASES = [
  mk(1, ['smoke', 'checkout'], 's1'),
  mk(2, ['checkout'], 's2'),
  mk(3, ['smoke'], 's2', { owner: 'Ann' }),
  mk(4, ['pricing'], undefined, { status: 'draft', lastResult: null, learned: [] }),
];

const fake = createFakeTrpc({
  'projects.list': () => [{ key: 'SHOP', name: 'Storefront' }],
  'models.status': () => ({ system1: { configured: false, reachable: false }, system2: { configured: false, reachable: false } }),
  'suites.tree': () => ({
    tree: [
      { id: 's1', name: 'Checkout', position: 0, caseCount: 1, totalCount: 3, children: [{ id: 's2', name: 'Guest', parentId: 's1', position: 0, caseCount: 2, totalCount: 2, children: [] }] },
    ],
    totalCases: 4,
    unsortedCases: 1,
  }),
  syncStatus: () => ({ clean: true, changedFiles: [], conflicts: [] }),
  'environments.list': () => [{ id: 'e1', name: 'staging', baseUrl: 'http://x' }],
  'cases.list': (i) => {
    const input = i as { suiteId?: string; query?: string };
    const tag = /tags:(\S+)/.exec(input.query ?? '')?.[1];
    const inSuite = (id: string | undefined) => input.suiteId === undefined || id === input.suiteId || (input.suiteId === 's1' && id === 's2');
    const items = CASES.filter((c) => inSuite(c.suiteId) && (tag === undefined || c.tags.includes(tag)));
    return { items, total: items.length, page: 1, pageSize: 25 };
  },
});

let httpServer: Server;
let vite: ViteDevServer;
let browser: Browser;
let base = '';

beforeAll(async () => {
  httpServer = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      void fake
        .fetch(`http://fake${req.url ?? '/'}`, { method: req.method ?? 'GET', ...(body ? { body } : {}) })
        .then(async (r) => {
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(await r.text());
        });
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  process.env['S1PILOT_SERVER_URL'] = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  vite = await createServer({ root: ROOT, server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await vite.listen();
  const addr = vite.httpServer?.address();
  if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
  browser = await chromium.launch();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await vite?.close();
  await new Promise((resolve) => httpServer?.close(resolve));
});

const rowCount = (page: Page) => page.locator('tbody tr').count();

describe('test cases screen (headless Chromium, fake server)', () => {
  it('keeps filter and suite in the URL, restores them on back/forward, selects by keyboard', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${base}/p/SHOP/cases`);
    await page.getByLabel('Select SHOP-TC-1').waitFor();
    expect(await rowCount(page)).toBe(4);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/cases-1440.png`, fullPage: true });

    await page.getByLabel('Filter').fill('tags:smoke');
    await page.waitForURL((u) => u.searchParams.get('q') === 'tags:smoke');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2);

    await page.getByRole('button', { name: 'Expand Checkout' }).click();
    await page.getByRole('link', { name: /^Guest/ }).click();
    await page.waitForURL((u) => u.searchParams.get('suite') === 's2');
    expect(new URL(page.url()).searchParams.get('q')).toBe('tags:smoke');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);

    await page.goBack();
    await page.waitForURL((u) => !u.searchParams.has('suite'));
    expect(await page.getByLabel('Filter').inputValue()).toBe('tags:smoke');
    await page.goBack();
    await page.waitForURL((u) => !u.searchParams.has('q'));
    expect(await page.getByLabel('Filter').inputValue()).toBe('');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 4);
    await page.goForward();
    await page.waitForURL((u) => u.searchParams.get('q') === 'tags:smoke');
    expect(await page.getByLabel('Filter').inputValue()).toBe('tags:smoke');

    // keyboard selection on a fresh list
    await page.goto(`${base}/p/SHOP/cases`);
    const first = page.getByLabel('Select SHOP-TC-1');
    await first.waitFor();
    await first.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');
    expect(await page.getByLabel('Select SHOP-TC-1').isChecked()).toBe(true);
    expect(await page.getByLabel('Select SHOP-TC-3').isChecked()).toBe(true);
    expect(await page.getByLabel('Select SHOP-TC-2').isChecked()).toBe(false);
    await page.getByText('2 selected').waitFor();
    await page.close();
  });

  it('has no horizontal page scroll at 400px and scrolls the table inside its card', async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
    await page.goto(`${base}/p/SHOP/cases`);
    await page.getByLabel('Select SHOP-TC-1').waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/cases-400.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const wrap = await page.evaluate(() => {
      const el = document.querySelector('table')?.parentElement;
      return el === null || el === undefined ? null : { scroll: el.scrollWidth, client: el.clientWidth, overflowX: getComputedStyle(el).overflowX };
    });
    expect(wrap?.overflowX).toBe('auto');
    expect(wrap?.scroll ?? 0).toBeGreaterThan(wrap?.client ?? 0);
    await page.close();
  });
});
