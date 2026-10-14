// Records the product demo video for the website (site/assets/demo.mp4 + demo-poster.png) against a REAL System 1
// model. Manual only, never in CI: it calls the model endpoint and needs S1PILOT_API_KEY in the environment.
//
//   set -a; . ./.env; set +a
//   pnpm build
//   node e2e/record-demo.mjs [out-dir]          # default out-dir: site/assets (needs ffmpeg on PATH)
//
// Endpoint: S1PILOT_DEMO_MODEL_URL and S1PILOT_DEMO_MODEL (default: Clef via OpenRouter); the adapter is detected.
//
// The key reaches the app only through its environment; the UI is given the reference `env:S1PILOT_API_KEY`, so the
// key never appears on screen. Uses a fresh temporary data directory, so no personal data is recorded.
// Site: S1PILOT_DEMO_BASE_URL (default: the PlayLab login page).
/* global fetch, process, setTimeout, URL -- Node globals; this script is plain ESM, not TypeScript */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const CLI = fileURLToPath(new URL('../apps/cli/dist/index.js', import.meta.url));
const OUT = resolve(process.argv[2] ?? fileURLToPath(new URL('../site/assets', import.meta.url)));
const MODEL_URL = process.env['S1PILOT_DEMO_MODEL_URL'] ?? 'https://openrouter.ai/api/alpha/decisions';
const MODEL = process.env['S1PILOT_DEMO_MODEL'] ?? 'cloudflare/clef';
// PlayLab (a public Playwright practice site); the demo credentials are printed on its login page. They go into the
// environment as a variable and an encrypted secret, so the step text and the model never see the password.
const SITE = process.env['S1PILOT_DEMO_BASE_URL'] ?? 'https://playwrightlab.github.io/login.html';
const PROJECT = { name: 'PlayLab', key: 'PLAY' };
const TEST = 'Sign in with the email and password, then check the page says you have successfully signed in';
const DATA = { email: 'test@playlab.com', password: 'Password123' };
const SIZE = { width: 1440, height: 810 };

if (!process.env['S1PILOT_API_KEY']) throw new Error('Set S1PILOT_API_KEY (load .env first).');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Asks the OS for a free port. */
function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

mkdirSync(OUT, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 's1p-demo-'));
const videoDir = mkdtempSync(join(tmpdir(), 's1p-demo-video-'));
let appLog = '';
const port = await freePort();
const app = spawn(process.execPath, [CLI, 'ui', '--no-open', '--port', String(port), '--data-dir', dataDir], {
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
app.stdout.on('data', (d) => (appLog += d));
app.stderr.on('data', (d) => (appLog += d));
const appUrl = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  if (app.exitCode !== null || i > 300) throw new Error(`s1pilot ui did not start:\n${appLog}`);
  if (await fetch(`${appUrl}/api/health`).then((r) => r.ok, () => false)) break;
  await pause(200);
}

const browser = await chromium.launch({ slowMo: 40 });
const context = await browser.newContext({ viewport: SIZE, recordVideo: { dir: videoDir, size: SIZE } });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
const recordingStarted = Date.now();
let skipMs = 0;

/** Types like a person, so the viewer can follow. */
const type = async (locator, text) => {
  await locator.click();
  await locator.fill('');
  await locator.pressSequentially(text, { delay: 28 });
};

/** Waits for the run on screen to finish, approving each step System 1 escalates; returns the final status text. */
async function watchRun() {
  const approve = page.getByRole('button', { name: /^Approve / });
  const done = page.getByText(/Status: (passed|failed|blocked|needs-review)/);
  for (;;) {
    const which = await Promise.race([
      approve.waitFor({ timeout: 180_000 }).then(() => 'approve'),
      done.first().waitFor({ timeout: 180_000 }).then(() => 'done'),
    ]);
    if (which === 'done') return (await done.first().textContent()) ?? '';
    await pause(2500);
    await approve.click();
  }
}

try {
  await page.goto(`${appUrl}/projects/new`);
  await page.getByLabel('Project name').waitFor();
  skipMs = Date.now() - recordingStarted;
  await pause(1200);
  await type(page.getByLabel('Project name'), PROJECT.name);
  await type(page.getByLabel('Project key'), PROJECT.key);
  await type(page.getByLabel('Base URL'), SITE);
  await pause(600);
  await page.getByRole('button', { name: 'Continue to environments' }).click();

  await page.getByRole('heading', { name: 'Environments' }).waitFor();
  await pause(1200);
  await page.getByRole('button', { name: 'Continue to models' }).click();

  const s1 = page.getByRole('region', { name: 'System 1 decision model' });
  await s1.waitFor();
  await type(s1.getByLabel('Base URL'), MODEL_URL);
  await type(s1.getByLabel('Model'), MODEL);
  await type(s1.getByLabel('API key (optional)'), 'env:S1PILOT_API_KEY');
  await s1.getByRole('button', { name: 'Test connection' }).click();
  await s1.getByText(/Connected/).waitFor({ timeout: 60_000 });
  await pause(2500);
  await page.getByRole('button', { name: 'Continue to login setup' }).click();

  await page.getByRole('button', { name: 'Skip' }).click();
  const describe = page.getByLabel('Describe a test in plain language');
  await describe.waitFor();
  await type(describe, TEST);
  await pause(1200);
  await page.getByRole('button', { name: 'Save as draft' }).click();
  await page.getByText(/Draft case \S+ saved/).waitFor();
  await pause(1500);
  await page.getByRole('button', { name: 'Finish' }).click();
  await pause(1000);

  // Test data: the email as a variable, the password as an encrypted secret (models only ever see its key name).
  await page.getByRole('link', { name: 'Environments' }).first().click();
  const vars = page.getByRole('region', { name: 'Variables' });
  await vars.waitFor();
  await pause(1200);
  await vars.getByRole('button', { name: '+ Add' }).click();
  await type(vars.getByLabel('New variable key'), 'email');
  await type(vars.getByLabel('Value for email'), DATA.email);
  await vars.getByRole('button', { name: '+ Add' }).click();
  await type(vars.getByLabel('New variable key'), 'password');
  await vars.getByLabel('Type for password').selectOption('secret-encrypted');
  await type(vars.getByLabel('Value for password'), DATA.password);
  await pause(1500);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('button', { name: 'Save changes' }).and(page.locator('[disabled]')).waitFor();
  await pause(2000);

  await page.getByRole('link', { name: 'Test cases' }).first().click();
  await page.getByRole('link', { name: TEST.slice(0, 24) }).first().click();
  await pause(1500);
  await page.getByRole('button', { name: 'Run now', exact: true }).click();

  await page.waitForURL(/\/runs\/[^/]+\/live/);
  // Poster: the live run with the screencast and System 1's options, once the first decision is on screen.
  await page.getByText(/0\.\d\d/).first().waitFor({ timeout: 120_000 }).then(
    async () => {
      await pause(800);
      await page.screenshot({ path: join(OUT, 'demo-poster.png') });
    },
    () => undefined,
  );
  const explore = await watchRun();
  if (!explore.includes('passed')) throw new Error(`explore run ended with "${explore}"`);
  await pause(3000);

  await page.goto(`${appUrl}/p/${PROJECT.key}/cases`);
  await page.getByRole('link', { name: TEST.slice(0, 24) }).first().click();
  await pause(1000);
  await page.getByRole('link', { name: 'Learned script' }).click();
  await page.getByRole('region', { name: 'Learned script summary' }).getByText(/Ready/).waitFor();
  await pause(3000);

  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.waitForURL(/\/runs\/[^/]+\/live/);
  const runId = /\/runs\/([^/]+)\/live/.exec(page.url())?.[1] ?? '';
  const replay = await watchRun();
  if (!replay.includes('passed')) throw new Error(`replay run ended with "${replay}"`);
  await pause(2000);
  await page.goto(`${appUrl}/p/${PROJECT.key}/runs/${runId}`);
  await page.getByText(/✓ replay/).first().waitFor();
  await pause(4000);
} catch (error) {
  await page.screenshot({ path: join(videoDir, 'failure.png') }).catch(() => undefined);
  process.stderr.write(`Recording failed (screenshot and video in ${videoDir}):\n${appLog.slice(-3000)}\n`);
  throw error;
} finally {
  await context.close();
  await browser.close();
  app.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
}

const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
if (!webm) throw new Error(`no video in ${videoDir}`);
const ffmpeg = spawnSync(
  'ffmpeg',
  [
    '-y', '-loglevel', 'error', '-ss', (skipMs / 1000).toFixed(2), '-i', join(videoDir, webm),
    '-vf', 'scale=1920:1080:flags=lanczos,fps=30', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', join(OUT, 'demo.mp4'),
  ],
  { stdio: 'inherit' },
);
if (ffmpeg.status !== 0) throw new Error('ffmpeg failed');
rmSync(videoDir, { recursive: true, force: true });
process.stdout.write(`Wrote ${join(OUT, 'demo.mp4')} and demo-poster.png\n`);
