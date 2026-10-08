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
const SHOTS = process.env['DASHBOARD_SHOTS_DIR'];

const none = { passed: 0, failed: 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 };
let summaryCalls = 0;

// Seeded data mirroring the wireframe's example rows.
const fake = createFakeTrpc({
  'projects.list': () => [
    { key: 'SHOP', name: 'Storefront', counts: { cases: 42, environments: 3 }, lastRun: { id: 'r1', status: 'running', startedAt: new Date(Date.now() - 600_000).toISOString(), summary: none }, s1Model: 'clef-flash', status: 'running' },
    { key: 'ADMIN', name: 'Back office', counts: { cases: 18, environments: 1 }, lastRun: { id: 'r2', status: 'failed', startedAt: new Date(Date.now() - 86_400_000).toISOString(), summary: none }, s1Model: 'jev-9b', status: 'failing' },
    { key: 'MAIL', name: 'Webmail', counts: { cases: 9, environments: 2 }, lastRun: { id: 'r4', status: 'passed', startedAt: new Date(Date.now() - 7_200_000).toISOString(), summary: none }, s1Model: 'laya', status: 'passing' },
  ],
  'environments.list': (i) =>
    ({ SHOP: [{ name: 'dev' }, { name: 'staging' }, { name: 'prod' }], ADMIN: [{ name: 'staging' }], MAIL: [{ name: 'dev' }, { name: 'staging' }] })[(i as { projectKey: string }).projectKey],
  'models.status': () => ({ system1: { configured: false, reachable: false }, system2: { configured: false, reachable: false } }),
  'dashboard.summary': () => {
    summaryCalls += 1;
    return {
      passRate7d: 91.3,
      passRateSeries: [88, 90, 93, null, 92, 90, 94],
      runsToday: 12,
      runningNow: 1,
      needsReview: 5 + summaryCalls - 1,
      flaky: 3,
      quarantined: 1,
      modeMix7d: { replay: 60, heal: 15, explore: 25 },
    };
  },
  'runs.recent': () => [
    { id: 'r1', projectKey: 'SHOP', title: 'Smoke · SHOP', status: 'running', startedAt: null, summary: none, environment: 'staging', browsers: ['chromium'], mode: 'replay-heal', activeCaseSteps: 5 },
    { id: 'r2', projectKey: 'ADMIN', title: 'Regression · ADMIN', status: 'failed', startedAt: null, summary: { ...none, failed: 3 }, environment: 'staging', browsers: ['chromium', 'firefox', 'webkit'], mode: 'replay-heal', activeCaseSteps: null },
    { id: 'r3', projectKey: 'SHOP', title: 'Checkout e2e · SHOP', status: 'needs-review', startedAt: null, summary: { ...none, needsReview: 2 }, environment: 'staging', browsers: ['chromium'], mode: 'replay-heal', activeCaseSteps: null },
    { id: 'r4', projectKey: 'MAIL', title: 'Nightly · MAIL', status: 'passed', startedAt: null, summary: { ...none, passed: 9 }, environment: 'dev', browsers: ['firefox'], mode: 'replay-only', activeCaseSteps: null },
  ],
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

describe('dashboard (headless Chromium, seeded fake server)', () => {
  for (const width of [1440, 400]) {
    it(`renders every section at ${width}px without horizontal page scroll`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.goto(base + '/');
      await page.getByRole('link', { name: 'Smoke · SHOP' }).waitFor();
      await page.getByText('91.3%').waitFor();
      await page.getByRole('link', { name: 'SHOP · Storefront' }).waitFor();
      await page.getByText('dev · staging · prod').waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const order = await page.evaluate(() =>
        [...document.querySelectorAll('main > section, main > header, main > div')].map((e) => e.getAttribute('aria-label') ?? e.tagName),
      );
      expect(order).toEqual(['HEADER', 'Key metrics', 'DIV', 'Execution mode mix']);
      // Mode-mix segment widths equal the API percentages.
      const widths = await page.evaluate(() =>
        ['replay', 'heal', 'explore'].map((k) => (document.querySelector(`[data-segment="${k}"]`) as HTMLElement).style.width),
      );
      expect(widths).toEqual(['60%', '15%', '25%']);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/dashboard-${width}.png`, fullPage: true });
      await page.close();
    }, 60_000);
  }

  it('updates the running row and the tiles live from the sockets', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.routeWebSocket(/\/ws\/runs\/r1$/, (ws) => {
      ws.send(JSON.stringify({ type: 'snapshot', steps: [{ stepIndex: 0 }], currentCase: null }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'event', event: { type: 'step.started', stepIndex: 2 } })), 300);
    });
    await page.routeWebSocket(/\/ws\/workspace$/, (ws) => {
      ws.send(JSON.stringify({ type: 'workspace', liveRuns: 1, reviewCount: 5 }));
      setTimeout(() => ws.send(JSON.stringify({ type: 'run.status', runId: 'r1', status: 'running' })), 800);
    });
    summaryCalls = 0;
    await page.goto(base + '/');
    await page.getByText('staging · Chromium · step 1/5').or(page.getByText('staging · Chromium · step 3/5')).first().waitFor();
    await page.getByText('staging · Chromium · step 3/5').waitFor();
    // The run.status message re-fetched the summary: the seeded handler bumps "Needs review" per call.
    await page.getByRole('region', { name: 'Key metrics' }).getByText('6', { exact: true }).waitFor({ timeout: 10_000 });
    expect(summaryCalls).toBeGreaterThanOrEqual(2);
    await page.close();
  }, 60_000);
});
