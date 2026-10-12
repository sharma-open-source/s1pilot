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
const SHOTS = process.env['SHARED_STEPS_SHOTS_DIR'];

const STEP = (action: string, extra: Record<string, unknown> = {}) => ({ action, assert: [], inputs: [], ...extra });
const flows = [
  {
    id: 'f1',
    projectId: 'p1',
    name: 'Log in as role',
    params: ['role', 'password'],
    steps: [STEP('Open the login page', { expected: 'The sign-in form is shown' }), STEP('Log in as {role} with password {password}', { expected: 'The account menu shows {role}' })],
    usage: { steps: ['SHOP-TC-1', 'SHOP-TC-4', 'SHOP-TC-9'], preconditions: ['SHOP-TC-2'], flows: ['fresh-start'], logins: ['staging / admin'] },
    usageCount: 4,
  },
  { id: 'f2', projectId: 'p1', name: 'clear-cart', params: [], steps: [STEP('Open the cart and remove every item', { expected: 'The cart is empty' })], usage: { steps: [], preconditions: [], flows: [], logins: [] }, usageCount: 0 },
  { id: 'f3', projectId: 'p1', name: 'fresh-start', params: [], steps: [STEP('Run flow clear-cart', { sharedStepId: 'f2' }), STEP('Go to the home page')], usage: { steps: [], preconditions: [], flows: [], logins: [] }, usageCount: 0 },
];
const fake = createFakeTrpc({
  'projects.list': () => [{ key: 'SHOP', name: 'Storefront', counts: { cases: 9, environments: 1 }, lastRun: null, s1Model: null, status: 'none' }],
  'models.status': () => ({ system1: { configured: false, reachable: false }, system2: { configured: false, reachable: false } }),
  'sharedSteps.list': () => flows,
  'sharedSteps.get': (i) => {
    const f = flows.find((x) => x.id === (i as { id: string }).id);
    return { ...f, usedBy: [...(f?.usage.steps ?? []), ...(f?.usage.preconditions ?? [])] };
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

const overflowOf = (page: import('playwright').Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

describe('shared steps pages (headless Chromium, seeded fake server)', () => {
  for (const width of [1440, 400]) {
    it(`list and editor render at ${width}px without horizontal page scroll`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${base}/p/SHOP/library/shared-steps`);
      await page.getByText('3 shared steps').waitFor();
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/shared-list-${width}.png`, fullPage: true });

      await page.getByRole('link', { name: 'Log in as role', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).waitFor();
      expect(await page.getByLabel('Name', { exact: true }).inputValue()).toBe('Log in as role');
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/shared-edit-${width}.png`, fullPage: true });

      await page.goto(`${base}/p/SHOP/library/shared-steps/new`);
      await page.getByRole('button', { name: 'Create shared step' }).waitFor();
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/shared-new-${width}.png`, fullPage: true });
      await page.close();
    }, 60_000);
  }
});
