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
const SHOTS = process.env['REVIEW_SHOTS_DIR'];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/** In-memory queue: ids of pending items per tab. */
const pending: Record<string, string[]> = { heals: ['h1', 'h2', 'h3'], verdicts: ['v1'] };
const decisions: Array<Record<string, unknown>> = [];
const HEALS: Record<string, { title: string; meta: string }> = {
  h1: { title: 'Guest checkout button renamed', meta: 'Shared step “Checkout as guest” · used by 6 cases · conf 0.62' },
  h2: { title: 'Promo field moved into accordion', meta: 'SHOP-TC-43 step 2 · conf 0.88' },
  h3: { title: 'Size picker is now a dropdown', meta: 'SHOP-TC-42 step 2 · conf 0.91' },
};

const fake = createFakeTrpc({
  'reviews.counts': () => ({ verdicts: pending['verdicts']?.length ?? 0, heals: pending['heals']?.length ?? 0, drafts: 0, visual: 0 }),
  'reviews.list': (input) => {
    const { tab } = input as { tab: string };
    const ids = pending[tab] ?? [];
    return {
      page: 1,
      pageSize: 20,
      total: ids.length,
      items: ids.map((id) =>
        tab === 'heals'
          ? { id, tab, status: 'pending', createdAt: null, resolvedAt: null, caseKey: 'SHOP-TC-42', title: HEALS[id]?.title ?? id, stepNumber: 2, confidence: 0.62, sharedStepName: id === 'h1' ? 'Checkout as guest' : null, impactCount: id === 'h1' ? 6 : 1, environment: '', browser: null }
          : { id, tab, status: 'pending', createdAt: null, resolvedAt: null, caseKey: 'SHOP-TC-51', title: 'Order confirmation email arrives', stepNumber: 3, confidence: 0.55, sharedStepName: null, impactCount: null, environment: 'staging', browser: 'webkit' },
      ),
    };
  },
  'reviews.get': (id) => {
    if (id === 'v1') {
      return {
        kind: 'verdict', item: { id: 'v1', projectId: 'p1', kind: 'verdict', refId: 'cr1', status: 'pending' }, projectKey: 'SHOP', resultId: 'cr1', runId: 'run-abc123',
        caseKey: 'SHOP-TC-51', caseTitle: 'Order confirmation email arrives', environment: 'staging', browser: 'webkit', verdict: 'needs-review', stepNumber: 3,
        expected: 'A confirmation banner is shown', pTrue: 0.55, thresholds: { pass: 0.8, fail: 0.2 }, model: 'clef-flash',
        assertions: [{ stepNumber: 3, assertion: 'ai', verdict: 'needs-review', probability: 0.55, message: null }], screenshotId: 'shot1',
      };
    }
    const h = HEALS[id as string] ?? { title: 'Guest checkout button renamed', meta: '' };
    return {
      kind: 'heal', item: { id, projectId: 'p1', kind: 'heal', refId: `hp-${id as string}`, status: 'pending' }, projectKey: 'SHOP', proposalId: `hp-${id as string}`, proposalStatus: 'pending',
      caseKey: 'SHOP-TC-42', caseTitle: 'Guest checkout', stepNumber: 2, stepAction: 'Go to checkout as guest', environment: 'staging', runId: 'run-abc123', runFound: true, browser: 'chromium',
      sharedStepName: id === 'h1' ? 'Checkout as guest' : null, beforeLabel: 'Guest checkout', afterLabel: h.title, before: ["getByRole('button', {name: 'Guest checkout'})"],
      after: [`getByRole('button', {name: '${h.title}'})`], confidence: 0.62, s2Agreed: true, approvedLive: 'maya', impactCount: id === 'h1' ? 6 : 1, impactCaseKeys: [],
    };
  },
  'reviews.decide': (input) => {
    const { id } = input as { id: string };
    decisions.push(input as Record<string, unknown>);
    for (const tab of Object.keys(pending)) {
      const ids = pending[tab] ?? [];
      const at = ids.indexOf(id);
      if (at >= 0) {
        pending[tab] = ids.filter((x) => x !== id);
        return { item: { id, status: 'approved' }, nextId: ids[at + 1] ?? ids[at - 1] ?? null };
      }
    }
    return { item: { id }, nextId: null };
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

async function open(width: number, path: string) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.route('**/api/artifacts/*', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.goto(base + path);
  return page;
}

describe('review queue (headless Chromium)', () => {
  for (const width of [1440, 400]) {
    it(`renders the heal proposal at ${width}px without horizontal page scroll`, async () => {
      const page = await open(width, '/p/SHOP/review?tab=heals');
      await page.getByRole('heading', { name: 'Review queue' }).waitFor();
      await page.getByRole('region', { name: 'Proposal detail' }).getByText('Before · learned script').waitFor();
      await page.getByRole('button', { name: 'Approve for all 6 cases' }).waitFor();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/review-${width}.png`, fullPage: true });
      await page.close();
    }, 60_000);
  }

  it('approving advances to the next item and the tab count drops', async () => {
    const page = await open(1440, '/p/SHOP/review?tab=heals');
    await page.getByRole('link', { name: 'Heal proposals · 3' }).waitFor();
    await page.getByLabel('Note (optional)').fill('Intentional rename');
    await page.getByRole('button', { name: 'Approve for all 6 cases' }).click();
    await page.getByRole('link', { name: 'Heal proposals · 2' }).waitFor();
    await page.getByRole('heading', { name: /Promo field moved into accordion/ }).waitFor();
    expect(decisions[0]).toMatchObject({ id: 'h1', decision: 'approve', note: 'Intentional rename' });
    await page.close();
  }, 60_000);

  it('marks an uncertain verdict failed', async () => {
    const page = await open(1440, '/p/SHOP/review?tab=verdicts');
    await page.getByText('P(expected result is true)').waitFor();
    await page.getByRole('button', { name: 'Mark failed' }).click();
    await page.getByRole('link', { name: 'Uncertain verdicts · 0' }).waitFor();
    expect(decisions.at(-1)).toMatchObject({ id: 'v1', decision: 'reject', verdict: 'failed' });
    await page.close();
  }, 60_000);
});
