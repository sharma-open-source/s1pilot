// @vitest-environment node
import { mkdirSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeTrpc, FakeTrpcError } from '../../test/fake-trpc';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SHOTS = process.env['CASE_EDITOR_SHOTS_DIR'];

const step = (action: string, extra: Record<string, unknown> = {}) => ({ action, assert: [], inputs: [], ...extra });

let stored = {
  id: 'c1',
  key: 'SHOP-TC-42',
  version: 3,
  title: 'Guest can check out a single item',
  priority: 'P1',
  type: 'e2e',
  status: 'ready',
  tags: ['checkout', 'guest', 'smoke'],
  requirements: ['SHOP-REQ-7'],
  preconditions: [{ flow: 'clear-cart' }, { auth: 'none (guest)' }],
  parameters: [
    { colour: 'blue', size: 'M' },
    { colour: 'black', size: 'L' },
  ],
  steps: [
    step('Search for "t-shirt" and open the "Classic Tee" product', { expected: 'The product page for Classic Tee is shown' }),
    step('Choose colour {colour} and size {size}, then add to cart', { expected: 'Cart badge shows 1 item', assert: [{ type: 'elementText', testId: 'status', contains: '1' }] }),
    step('Go to checkout as guest and fill the shipping form', { expected: 'The payment step is displayed', inputs: ['shipping_name', 'shipping_zip'], assert: [{ type: 'urlMatches', pattern: '/checkout/payment' }] }),
    step('Stop before payment', { expected: 'No order has been placed' }),
  ],
};

const YAML = () => `key: SHOP-TC-42\nversion: ${stored.version}\ntitle: ${stored.title}\nsteps:\n${stored.steps.map((s) => `  - action: ${String(s['action'])}`).join('\n')}\n`;

const fake = createFakeTrpc({
  'projects.list': () => [{ key: 'SHOP', name: 'Storefront' }],
  'models.status': () => ({ system1: { configured: false, reachable: false }, system2: { configured: false, reachable: false } }),
  'cases.get': () => ({
    ...stored,
    suitePath: [
      { id: 's1', name: 'Checkout' },
      { id: 's2', name: 'Guest' },
    ],
    learned: [
      { environmentId: 'e1', environmentName: 'staging', status: 'current', caseVersion: stored.version, healCount: 0, pendingProposals: 0 },
      { environmentId: 'e2', environmentName: 'dev', status: 'none' },
    ],
    lastResult: null,
  }),
  'environments.list': () => [
    { id: 'e1', name: 'staging', baseUrl: 'http://x' },
    { id: 'e2', name: 'dev', baseUrl: 'http://y' },
  ],
  'sharedSteps.list': () => [],
  'requirements.list': () => [{ key: 'SHOP-REQ-7', title: 'Guest checkout', caseKeys: ['SHOP-TC-42'], coverage: 1 }],
  'cases.update': (i) => {
    const input = i as { expectedVersion: number; patch: Record<string, unknown> };
    if (input.expectedVersion !== stored.version) throw new FakeTrpcError('stale', 'CONFLICT');
    stored = { ...stored, ...input.patch, version: stored.version + 1 } as typeof stored;
    return stored;
  },
  'cases.yaml': () => ({ key: 'SHOP-TC-42', version: stored.version, yaml: YAML() }),
  'runs.create': () => ({ id: 'run-1' }),
  syncStatus: () => ({ clean: true, changedFiles: [], conflicts: [] }),
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

describe('case editor (headless Chromium, fake server)', () => {
  it('opens a case, edits, adds a check, saves, loads Monaco in the YAML tab and runs it', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${base}/p/SHOP/cases/SHOP-TC-42`);
    await page.waitForURL(/\/cases\/SHOP-TC-42\/steps$/);
    await page.getByLabel('Action of step 1').waitFor();
    if (SHOTS) {
      await page.getByText('How to write steps').click();
      await page.screenshot({ path: `${SHOTS}/case-editor-1440.png`, fullPage: true });
      await page.getByText('How to write steps').click();
    }

    await page.getByLabel('Action of step 4').fill('Stop before payment now');
    await page.getByRole('button', { name: 'Add check to step 4' }).click();
    await page.getByLabel('Check type').selectOption('titleContains');
    await page.getByLabel('Text (required)').fill('Payment');
    await page.getByRole('dialog').getByRole('button', { name: 'Add check' }).click();
    await page.getByText('title ⊇ "Payment"').waitFor();

    await page.keyboard.press('Control+s');
    await page.getByText('SHOP-TC-42', { exact: true }).locator('xpath=..').getByText('v4').waitFor();
    expect(stored.version).toBe(4);
    expect(stored.steps[3]?.['action']).toBe('Stop before payment now');

    await page.getByRole('link', { name: 'YAML' }).click();
    await page.getByTestId('yaml-monaco').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.monaco-editor').waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/case-editor-yaml-1440.png`, fullPage: true });

    await page.getByRole('link', { name: 'Steps' }).click();
    await page.getByRole('button', { name: 'Run now' }).click();
    await page.waitForURL(/\/runs\/run-1\/live$/);
    await page.close();
  }, 60_000);

  it('has no horizontal page scroll at 400px and scrolls the step grid inside its card', async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
    await page.goto(`${base}/p/SHOP/cases/SHOP-TC-42/steps`);
    await page.getByLabel('Action of step 1').waitFor();
    // The step-writing guide's examples must wrap too.
    await page.getByText('How to write steps').click();
    await page.getByText('Wait until "Upload complete" appears').waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/case-editor-400.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .filter((e) => e.getBoundingClientRect().right > 401 && !e.closest('table'))
        .slice(0, 6)
        .map((e) => `${e.tagName}.${String(e.className).slice(0, 60)} ${Math.round(e.getBoundingClientRect().right)}`),
    );
    expect(wide).toEqual([]);
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
