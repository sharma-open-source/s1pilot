// @vitest-environment node
import { mkdirSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeTrpc } from '../../test/fake-trpc';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SHOTS = process.env['DEFECTS_SHOTS_DIR'];

const DETAILS = {
  stepsToReproduce: ['Add “Classic Tee” to the cart', 'Reload the page', 'Open the cart'],
  expected: 'Item still in cart',
  actual: 'Cart is empty',
  environment: 'staging',
  browser: 'webkit',
  buildRef: 'abcdef1234567890',
  evidence: [{ artifactId: 'shot1', kind: 'screenshot' }],
  sourceKind: 'result',
  sourceLabel: 'SHOP-TC-45',
  stepIndex: 2,
  retest: true,
};
const rows: Array<Record<string, unknown>> = [
  { id: 'd1', key: 'DEF-1', title: 'Invalid ZIP accepted at checkout', severity: 'S2', status: 'open', source: 'SHOP-TC-44', sourceKind: 'result', failingBrowsers: ['webkit', 'firefox'], failingCount: 2, tracker: null, retest: true, retestRunId: null, createdAt: null },
  { id: 'd2', key: 'DEF-2', title: 'Missing label on promo code field', severity: 'S3', status: 'in-progress', source: 'accessibility scan', sourceKind: 'a11y', failingBrowsers: ['chromium'], failingCount: 1, tracker: null, retest: false, retestRunId: null, createdAt: null },
];
const created: Array<Record<string, unknown>> = [];

const fake = createFakeTrpc({
  'projects.list': () => [],
  'defects.list': (input) => {
    const { query } = input as { query: string };
    const items = query.includes('status:open') ? rows.filter((r) => r['status'] === 'open') : rows;
    return { total: rows.length, matched: items.length, items, page: 1, pageSize: 25 };
  },
  'defects.createFromResult': () => ({ projectKey: 'SHOP', resultId: 'cr1', stepNumber: 3, title: 'Cart empties after reload on iOS Safari', severity: 'S2', details: DETAILS }),
  'defects.create': (input) => {
    created.push(input as Record<string, unknown>);
    rows.unshift({ ...rows[0], id: 'd3', key: 'DEF-3', title: (input as { title: string }).title, severity: (input as { severity: string }).severity });
    return { id: 'd3' };
  },
  'defects.get': (id) => ({
    defect: { id, projectId: 'p1', title: 'Invalid ZIP accepted at checkout', severity: 'S2', status: 'open', linkedResultIds: ['cr1'], updatedAt: 't', details: DETAILS },
    key: 'DEF-1',
    projectKey: 'SHOP',
    linked: [],
  }),
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

describe('defects (headless Chromium)', () => {
  for (const width of [1440, 400]) {
    it(`renders the prefilled new defect at ${width}px without horizontal page scroll`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.goto(`${base}/p/SHOP/defects?fromResult=cr1&step=2`);
      await page.getByRole('heading', { name: 'Defects' }).waitFor();
      await page.getByLabel('Title').waitFor();
      expect(await page.getByLabel('Title').inputValue()).toBe('Cart empties after reload on iOS Safari');
      await page.getByText('Steps to reproduce · auto').waitFor();
      await page.getByText('Item still in cart').waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/defects-${width}.png`, fullPage: true });
      await page.close();
    }, 60_000);
  }

  it('creates a defect from the prefilled form and selects it', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${base}/p/SHOP/defects?fromResult=cr1&step=2`);
    await page.getByLabel('Title').waitFor();
    await page.getByLabel('Severity').selectOption('S1');
    await page.getByRole('button', { name: 'Create defect' }).click();
    await page.getByRole('complementary', { name: 'Defect detail' }).waitFor();
    expect(created[0]).toMatchObject({ severity: 'S1', resultIds: ['cr1'], details: { retest: true } });
    await page.close();
  }, 60_000);

  it('filters the list with status:open', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${base}/p/SHOP/defects`);
    await page.getByText('Missing label on promo code field').waitFor();
    await page.getByLabel('Filter defects').fill('status:open');
    await page.waitForFunction(() => !document.body.textContent?.includes('Missing label on promo code field'));
    expect(await page.getByRole('row').count()).toBeGreaterThan(1);
    await page.close();
  }, 60_000);
});
