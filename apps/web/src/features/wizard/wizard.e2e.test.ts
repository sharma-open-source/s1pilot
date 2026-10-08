// @vitest-environment node
import { mkdirSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeTrpc, FakeTrpcError } from '../../test/fake-trpc';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SHOTS = process.env['WIZARD_SHOTS_DIR'];

const CAPS = { maxOptions: 8, multiQuestionPerCall: true, supportsImages: true, maxContextTokens: 32768, orderSensitive: false };

/** Fake S1 Pilot server: only the procedures the wizard calls, with a probe that reports a cloud System 2. */
const fake = createFakeTrpc({
  'projects.list': () => [],
  'models.status': () => ({ system1: { configured: false, reachable: false }, system2: { configured: false, reachable: false } }),
  'projects.create': (i) => {
    const key = (i as { key: string }).key;
    if (key === 'TAKEN') throw new FakeTrpcError('exists', 'CONFLICT');
    return { key };
  },
  'projects.update': () => ({}),
  'environments.list': () => [{ id: 'e1', name: 'dev', baseUrl: 'http://127.0.0.1:4400/shop' }],
  'environments.create': (i) => ({ id: 'e2', ...(i as object) }),
  'models.probe': (i) => {
    const input = i as { adapter: string; baseUrl: string };
    if (input.baseUrl.includes('down')) {
      return { ok: false, latencyMs: { p50: 0, samples: [] }, isCloud: false, warnings: [], error: 'connect ECONNREFUSED' };
    }
    return {
      ok: true,
      adapter: input.adapter === 'auto' ? 'decide' : input.adapter,
      model: 'clef-flash',
      capabilities: CAPS,
      latencyMs: { p50: 87, samples: [87] },
      isCloud: input.adapter === 'openai-chat',
      warnings: [],
    };
  },
  'models.updateSettings': () => ({}),
  'cases.create': () => ({ key: 'SHOP-TC-1' }),
  'runs.start': () => ({ runId: 'r1' }),
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

async function noHorizontalScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, where).toBeLessThanOrEqual(0);
}

async function shot(page: Page, name: string, width: number) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${width}.png`, fullPage: true });
}

describe('new project wizard (headless Chromium, fake server)', () => {
  for (const width of [1440, 400]) {
    it(`completes all five steps at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      fake.calls.length = 0;
      await page.goto(`${base}/projects/new`);
      await page.getByRole('heading', { level: 1, name: 'Create project' }).waitFor();

      // Step 1
      await page.getByLabel('Project name').fill('Storefront');
      expect(await page.getByLabel('Project key').inputValue()).toBe('STOREFRONT');
      await page.getByLabel('Project key').fill('shop');
      await page.getByLabel('Base URL').fill('http://127.0.0.1:4400/shop');
      await noHorizontalScroll(page, 'basics');
      await shot(page, '1-basics', width);
      await page.getByRole('button', { name: 'Continue to environments' }).click();

      // Step 2
      await page.getByLabel('Environment 1 name').waitFor();
      expect(new URL(page.url()).searchParams.get('step')).toBe('environments');
      await page.getByRole('button', { name: '+ Add environment' }).click();
      await page.getByLabel('Environment 2 name').fill('staging');
      await page.getByLabel('Environment 2 base URL').fill('http://staging.test');
      await noHorizontalScroll(page, 'environments');
      await shot(page, '2-environments', width);
      await page.getByRole('button', { name: 'Continue to models' }).click();

      // Step 3
      const s1 = page.getByRole('region', { name: 'System 1 decision model' });
      await s1.waitFor();
      await s1.getByLabel('Base URL').fill('http://localhost:8000');
      await s1.getByLabel('Model').fill('clef-flash');
      await s1.getByRole('button', { name: 'Test connection' }).click();
      await page.getByText('Connected · decision returned in 87 ms').waitFor();
      const s2 = page.getByRole('region', { name: 'System 2 fallback model' });
      await s2.getByLabel('Base URL').fill('https://api.example.com/v1');
      await s2.getByLabel('Model').fill('gpt-4o-mini');
      await s2.getByRole('button', { name: 'Test connection' }).click();
      await page.getByText('Cloud endpoint detected for System 2 — page data leaves this machine.').waitFor();
      await noHorizontalScroll(page, 'models');
      await shot(page, '3-models', width);
      await page.getByRole('button', { name: 'Continue to login setup' }).click();

      // Step 4
      await page.getByRole('heading', { name: 'Login setup' }).waitFor();
      await noHorizontalScroll(page, 'login');
      await shot(page, '4-login', width);
      await page.getByRole('button', { name: 'Skip' }).click();

      // Step 5
      await page.getByLabel('Describe a test in plain language').fill('Add a product to the cart and check the badge shows 1');
      await noHorizontalScroll(page, 'first-tests');
      await shot(page, '5-first-tests', width);
      await page.getByRole('button', { name: 'Run now (explore)' }).click();
      await page.waitForURL('**/p/SHOP/runs/r1/live');

      const paths = fake.calls.map((c) => c.path);
      for (const p of ['projects.create', 'environments.create', 'models.updateSettings', 'cases.create', 'runs.start']) {
        expect(paths, p).toContain(p);
      }
      await page.close();
    }, 120_000);
  }

  it('shows a failed probe in the danger tone', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${base}/projects/new`);
    await page.getByLabel('Project name').fill('Down Shop');
    await page.getByLabel('Base URL').fill('http://x.test');
    await page.getByRole('button', { name: 'Continue to environments' }).click();
    await page.getByLabel('Environment 1 name').waitFor();
    await page.getByRole('button', { name: 'Continue to models' }).click();
    const s1 = page.getByRole('region', { name: 'System 1 decision model' });
    await s1.getByLabel('Base URL').fill('http://down.test');
    await s1.getByRole('button', { name: 'Test connection' }).click();
    await page.getByRole('alert').filter({ hasText: 'connect ECONNREFUSED' }).waitFor();
    await shot(page, '3-models-error', 1440);
    await page.close();
  }, 60_000);
});
