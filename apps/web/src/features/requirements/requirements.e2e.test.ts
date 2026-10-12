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
const SHOTS = process.env['REQUIREMENTS_SHOTS_DIR'];

const reqs = [
  { id: 'r1', projectId: 'p1', key: 'SHOP-REQ-1', title: 'Guest can check out without creating an account', description: 'Guest checkout with shipping form, payment step and order confirmation email.', caseIds: [], caseKeys: ['SHOP-TC-1', 'SHOP-TC-2', 'SHOP-TC-3', 'SHOP-TC-4', 'SHOP-TC-5', 'SHOP-TC-6', 'SHOP-TC-7'], coveringCaseIds: [], coverage: 7 },
  { id: 'r2', projectId: 'p1', key: 'SHOP-REQ-2', title: 'Coupons apply percentage and flat discounts', caseIds: [], caseKeys: ['SHOP-TC-9'], coveringCaseIds: [], coverage: 1 },
  { id: 'r3', projectId: 'p1', key: 'JIRA-SHOP-1042', title: 'Wishlist is kept after logging in', caseIds: [], caseKeys: [], coveringCaseIds: [], coverage: 0 },
];
const fake = createFakeTrpc({
  'projects.list': () => [{ key: 'SHOP', name: 'Storefront', counts: { cases: 9, environments: 1 }, lastRun: null, s1Model: null, status: 'none' }],
  'models.status': () => ({ system1: { configured: false, reachable: false }, system2: { configured: false, reachable: false } }),
  'requirements.list': () => reqs,
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
      if (req.url?.startsWith('/api/')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
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

describe('requirements page (headless Chromium, seeded fake server)', () => {
  for (const width of [1440, 400]) {
    it(`renders at ${width}px without horizontal page scroll`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${base}/p/SHOP/library/requirements`);
      await page.getByText('3 requirements · 1 not covered').waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/requirements-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: 'New requirement' }).click();
      await page.getByRole('dialog', { name: 'New requirement' }).waitFor();
      const dialogOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(dialogOverflow).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/requirements-new-${width}.png` });
      await page.close();
    }, 60_000);
  }
});
