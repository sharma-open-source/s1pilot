import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFakeSystemOne, type FakeSystemOne } from './support/fake-systemone.js';

/**
 * S-048 · "first test in 5 minutes": the real app (`s1pilot ui` from the built CLI), the fixture shop and a fake
 * System 1 server driven by an oracle mock. Nothing here reaches a real model endpoint or the network.
 */

const CLI = fileURLToPath(new URL('../apps/cli/dist/index.js', import.meta.url));
const SHOTS = process.env['E2E_SHOTS_DIR'];
const TEST = 'Add the Classic Tee in Blue, size M, to the cart and check the cart badge shows 1';

let dataDir = '';
let app: ChildProcess | undefined;
let appUrl = '';
let appLog = '';
let fixture: FixtureServer;
let fixtureUrl = '';
let model: FakeSystemOne;
let browser: Browser;
let page: Page;

/** Ask the OS for a free port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** The fixture sites normally run on :4400 (as in the docs); fall back to a free port when it is taken. */
async function startFixtures(): Promise<FixtureServer> {
  try {
    return await startFixtureServer({ port: 4400 });
  } catch {
    return startFixtureServer();
  }
}

async function startApp(): Promise<void> {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'ui', '--no-open', '--port', String(port), '--data-dir', dataDir], {
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app = child;
  child.stdout.on('data', (d: Buffer) => (appLog += d.toString()));
  child.stderr.on('data', (d: Buffer) => (appLog += d.toString()));
  appUrl = `http://127.0.0.1:${port}`;
  const started = Date.now();
  const deadline = started + 90_000;
  let lastStatus = '';
  for (;;) {
    if (child.exitCode !== null) throw new Error(`s1pilot ui exited early:\n${appLog}`);
    try {
      const res = await fetch(`${appUrl}/api/health`);
      lastStatus = `HTTP ${res.status}`;
      if (res.ok) return;
    } catch {
      lastStatus = lastStatus === '' ? 'no connection' : lastStatus;
    }
    if (Date.now() > deadline) throw new Error(`s1pilot ui did not start after ${Date.now() - started} ms (${lastStatus}):\n${appLog}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function stopApp(): Promise<void> {
  const child = app;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 's1p-e2e-'));
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  fixture = await startFixtures();
  fixtureUrl = fixture.url;
  model = await startFakeSystemOne();
  await startApp();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(60_000);
});

afterAll(async () => {
  await browser?.close();
  await stopApp();
  await model?.close();
  await fixture?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

/** Runs `fn`; on failure attaches the app log and a screenshot to the error. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    await shot(`failed-${name.replace(/\W+/g, '-')}`).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name}: ${message}\n--- page: ${page.url()}\n--- app log:\n${appLog.slice(-3000)}`, { cause: error });
  }
}

describe('first test in 5 minutes', () => {
  let runId = '';

  it('creates a project, probes the model and writes the first test', async () => {
    await step('wizard', async () => {
      await page.goto(`${appUrl}/projects/new`);
      await page.getByLabel('Project name').fill('Fixture Shop');
      await page.getByLabel('Project key').fill('SHOP');
      await page.getByLabel('Base URL').fill(`${fixtureUrl}/shop`);
      await page.getByRole('button', { name: 'Continue to environments' }).click();

      await page.getByRole('heading', { name: 'Environments' }).waitFor();
      await page.getByRole('button', { name: 'Continue to models' }).click();

      await page.getByRole('heading', { name: /System 1/ }).waitFor();
      const s1 = page.getByRole('region', { name: 'System 1 decision model' });
      await s1.getByLabel('Base URL').fill(model.url);
      await s1.getByLabel('Model').fill('oracle');
      await s1.getByRole('button', { name: 'Test connection' }).click();
      await s1.getByText(/Connected/).waitFor();
      await shot('models-probe');
      await page.getByRole('button', { name: 'Continue to login setup' }).click();

      await page.getByRole('button', { name: 'Skip' }).click();
      await page.getByLabel('Describe a test in plain language').fill(TEST);
      await shot('first-test');
    });
  });

  it('runs it with AI, lets the human approve the unsure step and finishes passed', async () => {
    await step('run', async () => {
      model.escalateNextAction();
      await page.getByRole('button', { name: 'Run now (explore)' }).click();
      await page.waitForURL(/\/p\/SHOP\/runs\/[^/]+\/live/);
      runId = /\/runs\/([^/]+)\/live/.exec(page.url())?.[1] ?? '';
      expect(runId).not.toBe('');

      const approve = page.getByRole('button', { name: /^Approve / });
      await approve.waitFor({ timeout: 90_000 });
      await shot('live-escalation');
      await approve.click();

      await page.getByText('Status: passed').waitFor({ timeout: 120_000 });
      await shot('live-finished');
    });
  });

  it('saved a learned script for the case', async () => {
    await step('learned', async () => {
      await page.goto(`${appUrl}/p/SHOP/cases`);
      await page.getByRole('link', { name: /Add the Classic Tee/ }).first().click();
      await page.getByRole('link', { name: 'Learned script' }).click();
      await page.getByRole('region', { name: 'Learned script summary' }).getByText(/Ready · 1\/1 steps/).waitFor();
      await shot('learned');
    });
  });

  it('runs it again and the report shows replay mode', async () => {
    await step('replay', async () => {
      const calls = model.calls;
      await page.getByRole('button', { name: 'Run now' }).click();
      await page.waitForURL(/\/p\/SHOP\/runs\/[^/]+\/live/);
      const second = /\/runs\/([^/]+)\/live/.exec(page.url())?.[1] ?? '';
      expect(second).not.toBe(runId);
      await page.getByText('Status: passed').waitFor({ timeout: 120_000 });

      await page.goto(`${appUrl}/p/SHOP/runs/${second}`);
      await page.getByText(/✓ replay/).first().waitFor();
      await shot('report-replay');
      // Replay needs no model call.
      expect(model.calls).toBe(calls);
    });
  });
});
