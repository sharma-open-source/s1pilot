// @vitest-environment node
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeTrpc, FakeTrpcError } from '../../test/fake-trpc';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

let signedIn = false;
/** Fake team-mode server: sign-in flips `signedIn`; everything else the app shell asks for answers empty. */
const fake = createFakeTrpc({
  'session.status': () => ({ mode: 'team', needsSetup: false, authenticated: signedIn, sso: { label: 'Acme SSO' } }),
  'session.me': () => (signedIn ? { id: 'u1', name: 'Una Admin', email: 'una@example.com', role: 'viewer', mode: 'team' } : null),
  'session.login': (i) => {
    const { password } = i as { email: string; password: string };
    if (password !== 'correct horse battery') throw new FakeTrpcError('Invalid email or password', 'UNAUTHORIZED');
    signedIn = true;
    return { id: 'u1' };
  },
  'session.logout': () => {
    signedIn = false;
    return { ok: true };
  },
  'projects.list': () => [{ key: 'SHOP', name: 'Storefront', counts: { cases: 0, environments: 1 }, lastRun: null }],
  'models.status': () => ({ system1: { configured: false, reachable: false }, system2: { configured: false, reachable: false } }),
  'suites.tree': () => ({ tree: [], totalCases: 0, unsortedCases: 0 }),
  syncStatus: () => ({ clean: true, changedFiles: [], conflicts: [] }),
  'environments.list': () => [{ id: 'e1', name: 'staging', baseUrl: 'http://x' }],
  'cases.list': () => ({ items: [], total: 0, page: 1, pageSize: 25 }),
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
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await vite?.close();
  await new Promise((resolve) => httpServer?.close(resolve));
});

async function noHorizontalScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, where).toBeLessThanOrEqual(0);
}

describe('team mode login (headless Chromium, fake server)', () => {
  for (const width of [1440, 400]) {
    it(`blocks the app until sign-in, shows errors, then opens the app at ${width}px`, async () => {
      signedIn = false;
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(`${base}/p/SHOP/cases`);
      await page.getByRole('heading', { level: 1, name: 'Sign in' }).waitFor();
      expect(await page.getByRole('navigation').count()).toBe(0); // no app chrome before sign-in
      expect(await page.getByRole('link', { name: 'Continue with Acme SSO' }).getAttribute('href')).toBe('/api/auth/oidc/login');
      await noHorizontalScroll(page, 'login');

      await page.getByLabel('Email').fill('una@example.com');
      await page.getByLabel('Password').fill('wrong password here');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByText('Invalid email or password').waitFor();

      await page.getByLabel('Password').fill('correct horse battery');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByRole('heading', { level: 1, name: 'Test cases' }).waitFor();
      // Viewer: no edit controls, but the signed-in user and Sign out are there.
      await page.getByRole('button', { name: 'Sign out' }).waitFor();
      await expect.poll(() => page.getByRole('button', { name: 'New test case' }).count()).toBe(0);
      await noHorizontalScroll(page, 'cases');
      await page.close();
    }, 90_000);
  }
});
