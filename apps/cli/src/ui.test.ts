import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from './program.js';
import { startUi, type UiHandle } from './ui.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 's1p-ui-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function webDist(): string {
  const dir = join(tmp(), 'web');
  mkdirSync(dir);
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>s1-pilot</title><div id="root"></div>');
  return dir;
}

async function start(open: boolean | undefined): Promise<{ handle: UiHandle; openBrowser: ReturnType<typeof vi.fn>; out: string[] }> {
  const openBrowser = vi.fn();
  const out: string[] = [];
  const handle = await startUi(
    { port: 0, dataDir: tmp(), webDist: webDist(), workers: 0, logLevel: 'silent', ...(open === undefined ? {} : { open }) },
    { openBrowser, stdout: (t) => out.push(t), env: {} },
  );
  cleanups.push(() => handle.close());
  return { handle, openBrowser, out };
}

describe('s1pilot ui', () => {
  it('serves the API and the web app (with SPA fallback) from one process', async () => {
    const { handle, out } = await start(false);
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(out.join('')).toContain(handle.url);
    const health = (await (await fetch(`${handle.url}/api/health`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
    const index = await fetch(`${handle.url}/p/SHOP/cases`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<div id="root">');
    expect((await fetch(`${handle.url}/api/nope`)).status).toBe(404);
  });

  it('opens the browser by default and not with --no-open', async () => {
    const opened = await start(undefined);
    expect(opened.openBrowser).toHaveBeenCalledWith(opened.handle.url);
    const quiet = await start(false);
    expect(quiet.openBrowser).not.toHaveBeenCalled();
  });

  it('fails with a clear error when the web build is missing', async () => {
    await expect(
      startUi({ port: 0, dataDir: tmp(), webDist: join(tmp(), 'missing'), workers: 0 }, { openBrowser: vi.fn(), stdout: () => undefined, env: {} }),
    ).rejects.toMatchObject({ code: 'WEB_DIST_MISSING' });
  });

  it('registers --port, --data-dir and --no-open', () => {
    const ui = buildProgram().commands.find((c) => c.name() === 'ui');
    expect(ui?.options.map((o) => o.long)).toEqual(['--port', '--data-dir', '--no-open']);
  });
});
