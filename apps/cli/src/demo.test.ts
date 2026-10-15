import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, repos } from '@s1pilot/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEMO_PROJECT_KEY, startDemo, startDemoModel } from './demo.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 's1p-demo-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function webDist(): string {
  const dir = join(tmp(), 'web');
  mkdirSync(dir);
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>s1pilot</title><div id="root"></div>');
  return dir;
}

describe('s1pilot demo', () => {
  it('starts the shop, the demo model and the app with the DEMO project and its ready test', async () => {
    const dataDir = tmp();
    const openBrowser = vi.fn();
    const out: string[] = [];
    const handle = await startDemo(
      { port: 0, shopPort: 0, dataDir, webDist: webDist(), workers: 0, logLevel: 'silent' },
      { openBrowser, stdout: (t) => out.push(t), env: {} },
    );
    cleanups.push(() => handle.close());

    expect(openBrowser).toHaveBeenCalledWith(`${handle.ui.url}/p/DEMO/cases`);
    expect(out.join('')).toContain('0 model calls');
    expect((await fetch(`${handle.shop.url}/shop`)).status).toBe(200);

    const db = openDb({ url: join(dataDir, 'data.db') });
    try {
      const project = await repos.projects.getByKey(db, DEMO_PROJECT_KEY);
      expect(project?.modelSettings?.system1.baseUrl).toBe(handle.model.url);
      const cases = await repos.cases.list(db, { projectId: project?.id ?? '' });
      expect(cases.map((c) => c.title)).toEqual(['Add a Classic Tee to the cart']);
    } finally {
      db.close();
    }
  });

  it('re-imports into an existing data directory with the new URLs', async () => {
    const dataDir = tmp();
    const deps = { openBrowser: vi.fn(), stdout: () => undefined, env: {} };
    const opts = { port: 0, shopPort: 0, dataDir, webDist: webDist(), workers: 0, logLevel: 'silent' as const, open: false };
    const first = await startDemo(opts, deps);
    await first.close();
    const second = await startDemo(opts, deps);
    cleanups.push(() => second.close());
    expect(deps.openBrowser).not.toHaveBeenCalled();
    const db = openDb({ url: join(dataDir, 'data.db') });
    try {
      const project = await repos.projects.getByKey(db, DEMO_PROJECT_KEY);
      expect(project?.modelSettings?.system1.baseUrl).toBe(second.model.url);
    } finally {
      db.close();
    }
  });

  it('demo model answers the systemone wire format from the oracle script', async () => {
    const model = await startDemoModel();
    cleanups.push(() => model.close());
    const res = await fetch(`${model.url}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'demo-oracle',
        state: { step: 'Open the "Classic Tee" product' },
        questions: { next_action: { type: 'choice', instructions: 'Which element?', criteria: { e1: '[link] Home', e2: '[link] Classic Tee' } } },
      }),
    });
    const body = (await res.json()) as { answers: Record<string, { choice?: string }> };
    expect(body.answers['next_action']?.choice).toBe('e2');
    expect(model.calls).toBe(1);
  });
});
