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
const SHOTS = process.env['MANUAL_SHOTS_DIR'];

/** The timer started 2 minutes before the "server" was created and keeps running (persisted server side). */
const TIMER_START = Date.now() - 120_000;
const verdicts: Record<number, string> = {};
const recorded: Array<Record<string, unknown>> = [];

const STEPS = [
  { action: 'Add “Classic Tee” to the cart', expected: 'cart badge shows 1 item' },
  { action: 'Reload the page', expected: 'page reloads without errors' },
  { action: 'Open the cart', expected: 'Classic Tee (blue, M) is still in the cart with quantity 1' },
  { action: 'Change quantity to 2', expected: 'subtotal doubles' },
];

const view = () => ({
  item: { id: 'm2', runId: 'run123456', status: 'in-progress', hybrid: true, notes: '' },
  projectKey: 'SHOP',
  caseKey: 'SHOP-TC-45',
  title: 'Cart keeps items after page reload',
  environment: 'staging',
  browser: 'webkit',
  device: null,
  buildRef: '2.4.0',
  steps: STEPS.map((s, index) => ({
    index,
    ...s,
    verdict: verdicts[index] ?? (index === 0 ? 'pass' : null),
    actual: '',
    attachments: [],
    preRun: index < 2 ? 'passed' : null,
    confirmed: index === 0,
  })),
  queue: [
    { id: 'm1', runId: 'run123456', caseKey: 'SHOP-TC-44', title: 'ZIP', status: 'done', verdict: 'passed', hybrid: false },
    { id: 'm2', runId: 'run123456', caseKey: 'SHOP-TC-45', title: 'Cart', status: 'in-progress', verdict: null, hybrid: true },
    { id: 'm3', runId: 'run123456', caseKey: 'SHOP-TC-47', title: 'Other', status: 'todo', verdict: null, hybrid: false },
  ],
  position: 2,
  total: 3,
  previousId: 'm1',
  nextId: 'm3',
  elapsedMs: Date.now() - TIMER_START,
  timerRunning: true,
  serverNow: new Date().toISOString(),
  preRunBrowser: 'webkit',
  preRunStepCount: 2,
});

const fake = createFakeTrpc({
  'projects.list': () => [],
  'manual.get': () => view(),
  'manual.start': () => view(),
  'manual.myQueue': () => [],
  'manual.recordStep': (input) => {
    const i = input as { stepIndex: number; verdict: string };
    verdicts[i.stepIndex] = i.verdict;
    recorded.push(i);
    return {};
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

const seconds = (text: string | null): number => {
  const [m, s] = (text ?? '0:00').split(':').map(Number);
  return (m ?? 0) * 60 + (s ?? 0);
};

describe('manual run (headless Chromium)', () => {
  for (const width of [1440, 400]) {
    it(`renders at ${width}px without horizontal page scroll`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      await page.goto(`${base}/p/SHOP/manual/m2`);
      await page.getByRole('heading', { level: 1, name: /SHOP-TC-45/ }).waitFor();
      await page.getByText('AI pre-run: passed · confirm?').waitFor();
      await page.getByRole('button', { name: 'Finish & next case' }).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/manual-${width}.png`, fullPage: true });
      await page.close();
    }, 60_000);
  }

  it('keeps the timer across a reload', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${base}/p/SHOP/manual/m2`);
    const timer = page.getByRole('timer');
    await timer.waitFor();
    const before = seconds(await timer.textContent());
    expect(before).toBeGreaterThanOrEqual(120);
    await page.reload();
    await page.getByRole('timer').waitFor();
    const after = seconds(await page.getByRole('timer').textContent());
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after).toBeLessThan(before + 30);
    await page.close();
  }, 60_000);

  it('records a verdict and links to a prefilled defect', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${base}/p/SHOP/manual/m2`);
    await page.getByRole('button', { name: 'Redo' }).first().click();
    const step2 = page.getByRole('article', { name: 'Step 2' });
    await step2.getByLabel('Actual result').fill('Page reloads but the cart is empty');
    await step2.getByRole('button', { name: 'Fail' }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Step 2 result"] [aria-pressed="true"]')?.textContent === 'Fail');
    expect(recorded.at(-1)).toMatchObject({ stepIndex: 1, verdict: 'fail', actual: 'Page reloads but the cart is empty' });
    await step2.getByRole('link', { name: 'Create defect from this step' }).click();
    await page.waitForURL(/\/p\/SHOP\/defects\?.*fromManual=m2.*step=1|\/p\/SHOP\/defects\?.*step=1.*fromManual=m2/);
    await page.close();
  }, 60_000);
});
