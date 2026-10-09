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
const SHOTS = process.env['PLANS_SHOTS_DIR'];

const envs = [
  { id: 'e1', projectId: 'p1', name: 'dev', baseUrl: 'https://dev.shop.example', readOnly: false, browsers: [{ browser: 'chromium' }] },
  { id: 'e2', projectId: 'p1', name: 'staging', baseUrl: 'https://staging.shop.example', readOnly: false, browsers: [{ browser: 'chromium' }] },
  { id: 'e3', projectId: 'p1', name: 'prod', baseUrl: 'https://shop.example', readOnly: true, browsers: [{ browser: 'chromium' }] },
];
const plan = {
  id: 'plan1',
  projectId: 'p1',
  name: 'Checkout regression',
  release: '2.4',
  selection: { kind: 'query', query: 'suite:Checkout AND priority<=P2 AND status:ready' },
  matrix: [
    { environmentId: 'e2', browser: 'chromium' },
    { environmentId: 'e2', browser: 'firefox' },
    { environmentId: 'e2', browser: 'webkit' },
  ],
  retries: 1,
  parallelism: 4,
  mode: 'replay-heal',
  unattended: 'block',
  schedule: '0 2 * * 1-5',
  exitCriteria: [{ kind: 'p0-passed', params: { percent: 100 } }, { kind: 'review-queue-empty', params: {} }],
  checks: { a11y: true, consoleErrors: true, visual: false, video: true },
};
const fake = createFakeTrpc({
  'projects.list': () => [{ key: 'SHOP', name: 'Storefront', counts: { cases: 2, environments: 3 }, lastRun: null, s1Model: null, status: 'none' }],
  'models.status': () => ({ system1: { configured: false, reachable: false }, system2: { configured: false, reachable: false } }),
  'environments.list': () => envs,
  'plans.list': () => [{ ...plan, lastRun: { id: 'run-abcdef123456', status: 'passed', startedAt: new Date().toISOString(), summary: {} } }],
  'plans.get': () => ({ ...plan, lastRun: null }),
  'plans.update': () => plan,
  'plans.preview': (i) => {
    const q = (i as { selection: { query?: string } }).selection.query ?? '';
    if (q.includes('((')) throw new FakeTrpcError('Unbalanced parenthesis at position 1', 'BAD_REQUEST');
    return { matched: 12, learned: 9, notLearned: 3, quarantined: 1, executions: 33, estimateMin: 4.2, jobs: 33, combos: [{}, {}, {}], skippedCombos: [], cases: [] };
  },
  'runs.create': () => ({ id: 'run-1', status: 'queued' }),
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

describe('plan builder (headless Chromium, seeded fake server)', () => {
  for (const width of [1440, 400]) {
    it(`renders the builder at ${width}px without horizontal page scroll`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.goto(`${base}/p/SHOP/plans/plan1`);
      await page.getByRole('heading', { name: '1 · Which cases' }).waitFor();
      await page.getByRole('heading', { name: '2 · Where to run' }).waitFor();
      await page.getByRole('heading', { name: '3 · How to run' }).waitFor();
      await page.getByRole('heading', { name: 'Triggers' }).waitFor();
      await page.getByRole('heading', { name: 'Exit criteria' }).waitFor();
      await page.getByRole('heading', { name: 'Estimate' }).waitFor();
      await page.getByText('12 cases match').waitFor();
      await page.getByText('11 cases × 3 combos = 33 executions').waitFor();
      await page.getByText('At 02:00, Mon–Fri').waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/plan-builder-${width}.png`, fullPage: true });
      await page.close();
    }, 60_000);
  }

  it('shows an inline syntax error from the preview', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${base}/p/SHOP/plans/plan1`);
    const q = page.getByLabel('Query');
    await q.fill('((');
    await page.getByText('Unbalanced parenthesis at position 1').waitFor({ timeout: 1500 });
    await page.close();
  }, 60_000);

  it('Run plan now saves, creates the run and opens the live view', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${base}/p/SHOP/plans/plan1`);
    await page.getByText('12 cases match').waitFor();
    await page.getByRole('button', { name: 'Run plan now' }).click();
    await page.waitForURL(/\/runs\/run-1\/live$/);
    await page.close();
  }, 60_000);

  it('lists plans at 400px', async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
    await page.goto(`${base}/p/SHOP/plans`);
    await page.getByRole('link', { name: 'Checkout regression' }).waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/plans-list-400.png`, fullPage: true });
    await page.close();
  }, 60_000);
});
