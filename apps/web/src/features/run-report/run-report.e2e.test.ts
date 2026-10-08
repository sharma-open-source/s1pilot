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
const SHOTS = process.env['RUN_REPORT_SHOTS_DIR'];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const verdicts: Record<string, string> = { r1: 'passed', r2: 'failed', r3: 'failed', r4: 'blocked' };
const summary = () => {
  const n = (v: string) => Object.values(verdicts).filter((x) => x === v).length;
  return { passed: n('passed'), failed: n('failed'), blocked: n('blocked'), skipped: 0, flaky: 0, needsReview: n('needs-review') };
};
const rows = [
  ['r1', 'SHOP-TC-42', 'Add to cart updates the badge', 'chromium'],
  ['r2', 'SHOP-TC-44', 'Invalid ZIP shows a field error', 'webkit'],
  ['r3', 'SHOP-TC-44', 'Invalid ZIP shows a field error', 'firefox'],
  ['r4', 'SHOP-TC-51', 'Order confirmation email arrives', 'chromium'],
] as const;

const fake = createFakeTrpc({
  'runs.report': () => ({
    run: { id: 'run-abc123', projectId: 'p1', trigger: 'manual', status: 'failed', buildRef: 'a1b2c3d', summary: summary() },
    projectKey: 'SHOP',
    environments: ['staging'],
    exitCriteria: null,
    results: rows.map(([id, key, title, browser]) => ({
      id, caseId: `c-${key}`, key, title, verdict: verdicts[id], environment: 'staging', browser, mode: 'explore', attempt: 1, durationMs: 10,
      failedStep: verdicts[id] === 'failed' ? 3 : verdicts[id] === 'blocked' ? 5 : null,
    })),
  }),
  'results.get': (id) => {
    const [rid, key, title, browser] = rows.find((r) => r[0] === id) ?? rows[0];
    return {
      result: { id: rid, runId: 'run-abc123', caseId: `c-${key}`, caseVersion: 1, browser, attempt: 1, verdict: verdicts[rid], durationMs: 10, mode: 'explore', escalations: 0 },
      projectKey: 'SHOP',
      case: { id: `c-${key}`, key, title },
      environment: 'staging',
      failedStep: 3,
      steps: [
        { id: 's0', caseResultId: rid, stepIndex: 0, status: 'passed', mode: 'replay', decisions: [], assertions: [], evidence: [], latencyMs: 5, action: 'Add item', screenshotId: 'a1' },
        { id: 's1', caseResultId: rid, stepIndex: 1, status: 'passed', mode: 'healed', decisions: [], assertions: [], evidence: [], latencyMs: 5, action: 'Guest checkout', screenshotId: 'a2' },
        {
          id: 's2', caseResultId: rid, stepIndex: 2, status: 'failed', mode: 'explore', actionTaken: 'fill e12 (textbox "ZIP")',
          decisions: [{ questionId: 'pick', options: ['e12'], probabilities: { e12: 0.97, e15: 0.03 }, chosen: 'e12', confidence: 0.97, model: 'clef-flash', latencyMs: 80 }],
          assertions: [{ assertion: 'ai', verdict: 'fail', probability: 0.07 }], evidence: [], latencyMs: 90, action: 'Enter ZIP "ABCDE"', expected: 'An error appears next to the ZIP field', screenshotId: 'a3',
        },
      ],
      notRun: [{ index: 3, action: 'Pay' }],
      video: null,
      trace: { artifactId: 'tr1', size: 10 },
      console: [{ ts: 't', type: 'error', text: 'Boom' }],
      network: [{ url: 'http://x.test/api', method: 'GET', status: 500, durationMs: 12, resourceType: 'fetch' }],
      overrides: [],
    };
  },
  'results.overrideVerdict': (i) => {
    const { resultId, verdict } = i as { resultId: string; verdict: string };
    verdicts[resultId] = verdict;
    return { ok: true };
  },
  'runs.rerunFailed': () => ({ id: 'run-new' }),
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

async function open(width: number, path: string) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.route('**/api/artifacts/*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.goto(base + path);
  return page;
}

describe('run report (headless Chromium, seeded failing run)', () => {
  for (const width of [1440, 400]) {
    it(`renders at ${width}px without horizontal page scroll and opens the deep-linked result`, async () => {
      const page = await open(width, '/p/SHOP/runs/run-abc123?result=r3');
      await page.getByRole('heading', { name: 'SHOP-TC-44 · Firefox · failed at step 3' }).waitFor();
      await page.getByText('P(expected result is true)').waitFor();
      await page.getByRole('region', { name: 'Summary' }).getByText('Needs review').waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/run-report-${width}.png`, fullPage: true });
      await page.close();
    }, 60_000);
  }

  it('override updates the counts, rerun navigates to the new run', async () => {
    const page = await open(1440, '/p/SHOP/runs/run-abc123');
    await page.getByRole('heading', { name: 'SHOP-TC-44 · WebKit · failed at step 3' }).waitFor();
    const summaryText = () => page.getByRole('region', { name: 'Summary' }).textContent();
    expect(await summaryText()).toContain('Failed2');
    await page.getByRole('button', { name: 'Override verdict' }).click();
    await page.getByLabel('New verdict').selectOption('passed');
    await page.getByLabel('Note').fill('Known data issue');
    await page.getByRole('button', { name: 'Save override' }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Summary"]')?.textContent?.includes('Failed1'));
    await page.getByRole('button', { name: 'Rerun failed' }).click();
    await page.waitForURL(/\/p\/SHOP\/runs\/run-new\/live/);
    await page.close();
  }, 60_000);
});
