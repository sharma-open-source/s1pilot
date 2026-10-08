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
const SHOTS = process.env['ENVIRONMENTS_SHOTS_DIR'];

const env = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: 'p1',
  name,
  baseUrl: `https://${name}.shop.example`,
  variables: [
    { key: 'shipping_zip', secret: false, value: '560001', source: 'inline' },
    { key: 'customer_password', secret: true, masked: true, source: 'inline' },
    { key: 'test_card', secret: true, masked: true, source: 'env', envVar: 'S1P_TEST_CARD' },
  ],
  allowDomains: [`${name}.shop.example`, 'pay.sandbox.example'],
  browsers: [{ browser: 'chromium' }],
  readOnly: false,
  requireApprovalFor: ['pay', 'delete', 'send'],
  locale: 'en-US',
  timezone: 'UTC',
  ...extra,
});

let loginStatus = 'never';
const fake = createFakeTrpc({
  'projects.list': () => [{ key: 'SHOP', name: 'Storefront', counts: { cases: 1, environments: 3 }, lastRun: null, s1Model: null, status: 'none' }],
  'models.status': () => ({ system1: { configured: false, reachable: false }, system2: { configured: false, reachable: false } }),
  'environments.list': () => [env('e1', 'dev'), env('e2', 'staging'), env('e3', 'prod', { readOnly: true })],
  'environments.update': (i) => ({ ...env('e2', 'staging'), ...(i as { patch: object }).patch }),
  'auth.list': () => [
    { id: 'a1', environmentId: 'e2', name: 'login-as-customer', kind: 'recorded', hasState: loginStatus === 'valid', status: loginStatus, ...(loginStatus === 'valid' ? { lastRefreshedAt: new Date().toISOString() } : {}) },
    { id: 'a2', environmentId: 'e2', name: 'login-as-admin', kind: 'flow', flowId: 'admin-login', hasState: false, status: 'expired' },
  ],
  'auth.record': () => ({ id: 'a1', recording: true }),
  'auth.finishRecording': () => {
    loginStatus = 'valid';
    return { id: 'a1', status: 'valid' };
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

describe('environments (headless Chromium, seeded fake server)', () => {
  for (const width of [1440, 400]) {
    it(`renders every section at ${width}px without horizontal page scroll`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.goto(`${base}/p/SHOP/environments/staging`);
      await page.getByRole('heading', { name: 'General' }).waitFor();
      await page.getByRole('heading', { name: 'Variables & secrets' }).waitFor();
      await page.getByRole('heading', { name: 'Test data sets' }).waitFor();
      await page.getByRole('heading', { name: 'Login setup' }).waitFor();
      await page.getByRole('heading', { name: 'Test mailbox' }).waitFor();
      await page.getByRole('heading', { name: 'Safeguards' }).waitFor();
      await page.getByText('Valid', { exact: true }).or(page.getByText('Not recorded')).first().waitFor();
      expect(await page.getByText('read-only').count()).toBeGreaterThan(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) {
        const offenders = await page.evaluate(() =>
          [...document.querySelectorAll('body *')]
            .filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !e.closest('.overflow-x-auto, .overflow-auto'))
            .slice(0, 12)
            .map((e) => `${e.tagName}.${String(e.className).slice(0, 80)} ${Math.round(e.getBoundingClientRect().right)}`),
        );
        console.log('OFFENDERS', offenders);
      }
      expect(overflow).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/environments-${width}.png`, fullPage: true });
      await page.close();
    }, 60_000);
  }

  it('redirects /environments to the first environment', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${base}/p/SHOP/environments`);
    await page.waitForURL(/\/environments\/dev$/);
    await page.close();
  }, 60_000);

  it('records a login and the status becomes Valid', async () => {
    loginStatus = 'never';
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${base}/p/SHOP/environments/staging`);
    await page.getByText('Not recorded').waitFor();
    await page.getByRole('button', { name: 'Record a login' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Check value').fill('Sign out');
    await dialog.getByRole('button', { name: 'Open browser' }).click();
    await dialog.getByText(/A browser window is open/).waitFor();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await page.getByText('Valid', { exact: true }).waitFor();
    await page.close();
  }, 60_000);
});
