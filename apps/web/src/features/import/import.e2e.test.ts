// @vitest-environment node
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFakeTrpc } from '../../test/fake-trpc';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const CSV = 'ID,Title,Suite,Priority,Steps\nT-1,Login works,Auth,High,Open login\nT-2,Logout,Auth,Low,Click Log out\n';
const MAPPING = { title: 'Title', id: 'ID', suite: 'Suite', priority: 'Priority', steps: 'Steps' };
const SAMPLE = [
  { externalRef: 'csv:T-1', title: 'Login works', suitePath: ['Auth'], priority: 'P1', tags: [], stepCount: 1, parameterRows: 0 },
  { externalRef: 'csv:T-2', title: 'Logout', suitePath: ['Auth'], priority: 'P3', tags: [], stepCount: 1, parameterRows: 0 },
];

let imported = false;
const fake = createFakeTrpc({
  'projects.list': () => [{ key: 'SHOP', name: 'Storefront' }],
  'models.status': () => ({ system1: { configured: false, reachable: false }, system2: { configured: false, reachable: false } }),
  'suites.tree': () => ({ tree: [{ id: 's1', name: 'Checkout', position: 0, caseCount: 0, totalCount: 0, children: [] }], totalCases: 0, unsortedCases: 0 }),
  syncStatus: () => ({ clean: true, changedFiles: [], conflicts: [] }),
  'environments.list': () => [],
  'cases.list': () => ({ items: [], total: 0, page: 1, pageSize: 25 }),
  'imports.preview': () => ({
    format: 'csv',
    headers: ['ID', 'Title', 'Suite', 'Priority', 'Steps'],
    mapping: MAPPING,
    total: 2,
    willCreate: imported ? 0 : 2,
    willUpdate: imported ? 2 : 0,
    sample: SAMPLE,
    errors: [],
  }),
  'imports.run': () => {
    const was = imported;
    imported = true;
    return { format: 'csv', created: was ? 0 : 2, updated: 0, skipped: was ? 2 : 0, errors: [], keys: ['SHOP-TC-1', 'SHOP-TC-2'] };
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
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await vite?.close();
  await new Promise((resolve) => httpServer?.close(resolve));
});

describe('import wizard (headless Chromium, fake server)', () => {
  it('uploads a CSV, previews the mapping, picks a suite and shows the report', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${base}/p/SHOP/cases`);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import test cases' });
    await dialog.getByLabel('File').setInputFiles({ name: 'cases.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await dialog.getByRole('button', { name: 'Preview' }).click();

    await dialog.getByText('2 cases found: 2 new, 0 will be updated').waitFor();
    expect(await dialog.getByLabel('Title *').inputValue()).toBe('Title');
    expect(await dialog.locator('tbody tr').count()).toBe(2);
    await dialog.getByRole('button', { name: 'Choose target suite' }).click();
    await dialog.getByLabel('Target suite').selectOption({ label: 'Checkout' });
    await dialog.getByRole('button', { name: 'Import 2 cases' }).click();
    await dialog.getByText('Import finished: 2 created, 0 updated, 0 skipped (unchanged), 0 errors.').waitFor();

    const run = fake.calls.find((c) => c.path === 'imports.run');
    expect(run?.input).toMatchObject({ projectKey: 'SHOP', filename: 'cases.csv', format: 'csv', suiteId: 's1', mapping: MAPPING });
    expect((run?.input as { content: string }).content).toBe(CSV);

    // re-import the same file: nothing is created again
    await dialog.getByRole('button', { name: 'Import another file' }).click();
    await dialog.getByLabel('File').setInputFiles({ name: 'cases.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await dialog.getByRole('button', { name: 'Preview' }).click();
    await dialog.getByText('2 cases found: 0 new, 2 will be updated').waitFor();
    await dialog.getByRole('button', { name: 'Choose target suite' }).click();
    await dialog.getByRole('button', { name: 'Import 2 cases' }).click();
    await dialog.getByText('Import finished: 0 created, 0 updated, 2 skipped (unchanged), 0 errors.').waitFor();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.close();
  });
});
