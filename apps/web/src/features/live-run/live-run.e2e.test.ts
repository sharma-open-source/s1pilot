// @vitest-environment node
import { mkdirSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeTrpc } from '../../test/fake-trpc';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SHOTS = process.env['LIVE_SHOTS_DIR'];

const TS = '2026-10-08T10:00:01.000Z';
const RUN_ID = 'run-abcdef123';
const RUN = { id: RUN_ID, projectId: 'p1', trigger: 'manual', status: 'running', summary: { passed: 0, failed: 0, blocked: 0, skipped: 0, flaky: 0, needsReview: 0 } };
const ESC = {
  type: 'escalation.needed',
  runId: RUN_ID,
  ts: TS,
  caseResultId: 'cr1',
  stepIndex: 2,
  escalationId: 'esc-1',
  reason: 'low-confidence',
  to: 'human',
  options: ['e3', 'e7', 'e2', 'scroll_down', 'stuck'],
  question: 'which element performs “Go to checkout as guest”?',
  probabilities: { e3: 0.62, e7: 0.21, e2: 0.09, scroll_down: 0.05, stuck: 0.03 },
  optionLabels: { e3: 'Checkout as guest', e7: 'Sign in to check out', e2: 'Continue shopping' },
  s2Choice: 'e3',
  thresholds: { act: 0.8 },
  detail: 'Waiting for your approval because the plan is attended.',
};
const SNAPSHOT = {
  type: 'snapshot',
  run: RUN,
  currentCase: { caseResultId: 'cr1', caseId: 'c1', caseKey: 'SHOP-TC-42' },
  steps: [
    { stepIndex: 0, action: 'Open Classic Tee', status: 'passed' },
    { stepIndex: 1, action: 'Pick colour & size', status: 'passed' },
    { stepIndex: 2, action: 'Checkout as guest', status: 'running' },
  ],
  lastDecision: null,
  pendingEscalations: [ESC],
};
const ELEMENTS = {
  type: 'event',
  event: {
    type: 'observation.elements',
    runId: RUN_ID,
    ts: TS,
    caseResultId: 'cr1',
    stepIndex: 2,
    chosenId: 'e3',
    elements: [
      { id: 'e3', role: 'button', label: 'Checkout as guest', box: { x: 640, y: 360, w: 320, h: 80 } },
      { id: 'e2', role: 'link', label: 'Continue shopping', box: { x: 64, y: 72, w: 256, h: 40 } },
    ],
  },
};

/** 1x1 PNG; the browser stretches it over the viewport box. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

function frame(seq: number, resultId = 'cr1'): Buffer {
  const id = Buffer.from(resultId);
  const header = Buffer.alloc(9);
  header.writeUInt8(id.length, 0);
  header.writeUInt32BE(seq, 1);
  header.writeUInt16BE(1280, 5);
  header.writeUInt16BE(720, 7);
  return Buffer.concat([header, id, PNG]);
}

const fake = createFakeTrpc({
  'projects.list': () => [{ key: 'SHOP', name: 'Storefront' }],
  'models.status': () => ({ system1: { configured: false, reachable: false }, system2: { configured: false, reachable: false } }),
  'runs.get': () => ({
    ...RUN,
    config: { environmentId: 'e1', environment: 'staging', browser: 'chromium', mode: 'replay-heal', attended: true },
    jobs: [
      { id: 'j1', status: 'running', attempts: 1, caseId: 'c1', caseKey: 'SHOP-TC-42' },
      { id: 'j2', status: 'queued', attempts: 0, caseId: 'c2', caseKey: 'SHOP-TC-43' },
    ],
    progress: { total: 2, queued: 1, running: 1, completed: 0, failed: 0, cancelled: 0 },
    results: [],
  }),
  'cases.get': () => ({
    key: 'SHOP-TC-42',
    title: 'Guest can check out',
    steps: [{ action: 'Open Classic Tee' }, { action: 'Pick colour & size' }, { action: 'Checkout as guest' }, { action: 'Stop before payment' }],
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

/** Opens the live page against a scripted run socket; returns the messages the page sent. */
async function open(width: number): Promise<{ page: Page; sent: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const sent: string[] = [];
  await page.routeWebSocket(/\/ws\/runs\//, (ws) => {
    ws.send(JSON.stringify(SNAPSHOT));
    ws.send(JSON.stringify(ELEMENTS));
    ws.send(frame(1));
    ws.onMessage((m) => {
      sent.push(String(m));
      const msg = JSON.parse(String(m)) as { type: string };
      if (msg.type === 'approve') {
        ws.send(JSON.stringify({ type: 'event', event: { type: 'escalation.resolved', runId: RUN_ID, ts: TS, escalationId: 'esc-1', resolution: 'approved', by: 'human', chosen: 'e3' } }));
      }
    });
  });
  await page.goto(`${base}/p/SHOP/runs/${RUN_ID}/live`);
  await page.getByRole('region', { name: 'System 1 decision' }).waitFor();
  await page.locator('[data-element="e3"]').waitFor();
  await page.locator('[data-testid="viewport"] img').waitFor();
  return { page, sent };
}

const rect = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  }, selector);

describe('live run screen (headless Chromium, scripted socket)', () => {
  it('shows the decision panel, approves, and keeps overlay boxes aligned with the frame at several widths', async () => {
    for (const width of [1440, 1000, 700]) {
      const { page, sent } = await open(width);
      // The viewport resizes once the frame image has loaded; measure after layout has settled, not mid-reflow.
      await expect
        .poll(async () => {
          const [v, b] = [await rect(page, '[data-testid="viewport"]'), await rect(page, '[data-element="e3"]')];
          return v !== null && b !== null && Math.abs(b.x - v.x - (640 / 1280) * v.w) < 0.5 && Math.abs(b.y - v.y - (360 / 720) * v.h) < 0.5;
        })
        .toBe(true);
      const vp = await rect(page, '[data-testid="viewport"]');
      const box = await rect(page, '[data-element="e3"]');
      if (vp === null || box === null) throw new Error('missing geometry');
      expect(box.x - vp.x).toBeCloseTo((640 / 1280) * vp.w, 0);
      expect(box.y - vp.y).toBeCloseTo((360 / 720) * vp.h, 0);
      expect(box.w).toBeCloseTo((320 / 1280) * vp.w, 0);
      expect(box.h).toBeCloseTo((80 / 720) * vp.h, 0);
      expect(vp.w / vp.h).toBeCloseTo(1280 / 720, 1);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/live-${width}.png`, fullPage: true });

      if (width === 1440) {
        await page.getByRole('button', { name: 'Approve e3' }).click();
        await page.getByRole('button', { name: 'Approve e3' }).waitFor({ state: 'detached' });
        expect(JSON.parse(sent.at(-1) as string)).toMatchObject({ type: 'approve', escalationId: 'esc-1', choice: 'e3' });
      }
      await page.close();
    }
  }, 90_000);

  it('restores state after a reload', async () => {
    const { page } = await open(1440);
    await page.reload();
    await page.getByRole('button', { name: 'Approve e3' }).waitFor();
    await page.getByText('3 · Checkout as guest', { exact: true }).waitFor();
    await page.close();
  });

  it('keeps three columns at 1440, wraps below 1100 and stacks at 400 without horizontal scroll', async () => {
    const wide = await open(1440);
    const tops = async (p: Page) =>
      p.evaluate(() => {
        const q = (label: string) => document.querySelector(`section[aria-label="${label}"]`)?.getBoundingClientRect();
        const s = q('Steps of current case');
        const b = q('Browser view');
        const d = q('System 1 decision');
        return { s: s && { x: s.x, y: s.y, w: s.width }, b: b && { x: b.x, y: b.y, w: b.width }, d: d && { x: d.x, y: d.y, w: d.width }, scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
    const w = await tops(wide.page);
    expect(Math.abs((w.s?.y ?? 0) - (w.b?.y ?? 1))).toBeLessThan(40);
    expect(Math.abs((w.d?.y ?? 0) - (w.b?.y ?? 1))).toBeLessThan(40);
    expect(w.scroll).toBeLessThanOrEqual(0);
    await wide.page.close();

    const mid = await open(1000);
    const m = await tops(mid.page);
    expect(m.scroll).toBeLessThanOrEqual(0);
    expect((m.d?.y ?? 0) > (m.b?.y ?? 0) || (m.d?.x ?? 0) > (m.b?.x ?? 0)).toBe(true);
    await mid.page.close();

    const narrow = await open(400);
    const n = await tops(narrow.page);
    expect(n.scroll).toBeLessThanOrEqual(0);
    expect(n.b?.y ?? 0).toBeGreaterThan(n.s?.y ?? 0);
    expect(n.d?.y ?? 0).toBeGreaterThan(n.b?.y ?? 0);
    if (SHOTS) await narrow.page.screenshot({ path: `${SHOTS}/live-400.png`, fullPage: true });
    await narrow.page.close();
  });

  it('shows parallel cases as a grid of live tiles (2 columns at 1440, 1 at 400) and opens one full size', async () => {
    const lanes = ['SHOP-TC-1', 'SHOP-TC-2', 'SHOP-TC-3', 'SHOP-TC-4'].map((caseKey, i) => ({
      caseResultId: `cr${i + 1}`,
      caseId: `c${i + 1}`,
      caseKey,
      steps: [{ stepIndex: 0, action: 'Open Classic Tee', status: 'running' }],
    }));
    for (const width of [1440, 400]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.routeWebSocket(/\/ws\/runs\//, (ws) => {
        ws.send(JSON.stringify({ ...SNAPSHOT, currentCase: lanes[3], steps: [], pendingEscalations: [], lanes }));
        for (const l of lanes) ws.send(frame(1, l.caseResultId));
      });
      await page.goto(`${base}/p/SHOP/runs/${RUN_ID}/live`);
      const grid = page.getByRole('region', { name: 'Parallel browsers' });
      await grid.waitFor();
      await expect.poll(() => grid.locator('img').count()).toBe(4);
      const xs = await grid.getByRole('button').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)));
      expect(new Set(xs).size).toBe(width === 1440 ? 2 : 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/live-grid-${width}.png`, fullPage: true });

      await grid.getByRole('button', { name: 'Open SHOP-TC-3 full size' }).click();
      await page.locator('[data-testid="viewport"] img').waitFor();
      await page.getByRole('heading', { level: 1, name: /^SHOP-TC-3 · run / }).waitFor();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/live-focused-${width}.png`, fullPage: true });
      await page.close();
    }
  }, 90_000);
});
