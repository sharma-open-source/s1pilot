// Cross-platform smoke test of the built CLI (CI runs it on Linux, macOS and Windows):
//   1. `s1pilot --version`
//   2. `s1pilot demo` starts, serves the API and the demo shop
//   3. `s1pilot run` passes the shop case against that shop with the mock adapter (real headless Chromium)
// Needs `pnpm build` and `playwright install chromium` first. No network, no model endpoint.
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'apps', 'cli', 'dist', 'index.js');
const cases = join(root, 'fixtures', 'sites', 'cases', 'shop');
const work = mkdtempSync(join(tmpdir(), 's1p-smoke-'));
const exec = promisify(execFile);

function fail(message) {
  console.error(`smoke: ${message}`);
  process.exitCode = 1;
}

const { stdout: version } = await exec(process.execPath, [cli, '--version']);
console.log(`smoke: version ${version.trim()}`);

const demo = spawn(process.execPath, [cli, 'demo', '--no-open', '--port', '0', '--data-dir', join(work, 'data')], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
demo.stdout.on('data', (d) => (log += d));
demo.stderr.on('data', (d) => (log += d));

try {
  const deadline = Date.now() + 60_000;
  while (!/Open http/.test(log)) {
    if (demo.exitCode !== null) throw new Error(`demo exited early:\n${log}`);
    if (Date.now() > deadline) throw new Error(`demo did not start within 60 s:\n${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const app = /running at (http:\/\/\S+)/.exec(log)?.[1];
  const shop = /Demo shop:\s+(http:\/\/\S+)/.exec(log)?.[1];
  const health = await fetch(`${app}/api/health`);
  if (!health.ok) throw new Error(`health check returned HTTP ${health.status}`);
  if (!(await fetch(shop)).ok) throw new Error(`demo shop ${shop} is not reachable`);
  console.log(`smoke: demo up (app ${app}, shop ${shop})`);

  const args = [cli, 'run', join(cases, 'tc-042.yaml'), '--env', 'local', '--adapter', 'mock', '--mock-script', join(cases, 'tc-042.mock.json')];
  args.push('--base-url', shop, '--mode', 'explore', '--out', join(work, 'res'));
  try {
    const { stdout } = await exec(process.execPath, args, { cwd: root, timeout: 180_000 });
    console.log(stdout.trim());
    console.log('smoke: run passed');
  } catch (error) {
    throw new Error(`run exited with code ${error.code}:\n${error.stdout}\n${error.stderr}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  demo.kill();
  await new Promise((r) => (demo.exitCode !== null ? r() : demo.once('exit', r)));
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
