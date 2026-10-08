import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EnvironmentSchema, createRedactor, newId } from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, loadMockScript, mockResolver } from '@s1pilot/providers';
import { loadCaseFile } from '@s1pilot/sync';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MASK_COLOR, captureScreenshot } from './capture.js';
import { runCases } from './run-cases.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const casesDir = fileURLToPath(new URL('../../../fixtures/sites/cases/shop/', import.meta.url));
const tmp = (): string => mkdtempSync(join(tmpdir(), 's1p-capture-'));
const VALUES: Record<string, string> = { search_term: 't-shirt', shipping_name: 'Alex Doe', shipping_zip: '94105' };

let server: FixtureServer;
let browser: Browser;
beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await server.close();
});

/** Colour of one pixel of a PNG, decoded by the browser. */
async function pixel(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const page = await browser.newPage();
  try {
    await page.setContent('<canvas id="c"></canvas>');
    const url = `data:image/png;base64,${png.toString('base64')}`;
    const rgb = await page.evaluate(`new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.getElementById('c');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(Array.from(ctx.getImageData(${x}, ${y}, 1, 1).data).slice(0, 3));
      };
      img.src = ${JSON.stringify(url)};
    })`);
    return rgb as [number, number, number];
  } finally {
    await page.close();
  }
}

describe('captureScreenshot', () => {
  it('masks fields holding a secret value and password inputs', async () => {
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent(`<body style="margin:0;background:#fff">
      <input id="a" value="hunter2-secret" style="position:absolute;left:10px;top:10px;width:200px;height:40px;background:#00ff00">
      <input id="b" type="password" value="x" style="position:absolute;left:10px;top:70px;width:200px;height:40px;background:#00ff00">
      <input id="c" value="public" style="position:absolute;left:10px;top:130px;width:200px;height:40px;background:#00ff00">
    </body>`);
    const file = join(tmp(), 'shot.png');
    expect(await captureScreenshot(page, file, ['hunter2-secret'])).toBe(true);
    const png = readFileSync(file);
    const hex = (c: [number, number, number]): string => c.map((v) => v.toString(16).padStart(2, '0')).join('');
    expect(hex(await pixel(png, 100, 30))).toBe(MASK_COLOR.slice(1).toLowerCase()); // secret value
    expect(hex(await pixel(png, 100, 90))).toBe(MASK_COLOR.slice(1).toLowerCase()); // password
    expect(hex(await pixel(png, 5, 150))).not.toBe(MASK_COLOR.slice(1).toLowerCase());
    expect(hex(await pixel(png, 200, 150))).toBe('00ff00'); // unmasked field keeps its colour
    // the marker attribute is removed again
    expect(await page.locator('[data-s1-mask]').count()).toBe(0);
    await page.close();
  });
});

describe('runCases evidence', () => {
  it('writes step screenshots, trace.zip, console/network logs and video', async () => {
    const env = EnvironmentSchema.parse({ id: newId(), projectId: newId(), name: 'local', baseUrl: `${server.url}/shop` });
    const out = tmp();
    const script = loadMockScript(join(casesDir, 'tc-042.mock.json'));
    const report = await runCases({
      cases: [loadCaseFile(join(casesDir, 'tc-042.yaml'))],
      environment: env,
      browser,
      browserName: 'chromium',
      models: {
        s1: new MockDecisionModel({ fallback: mockResolver(script) }),
        thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 },
        modelName: 'mock',
      },
      out,
      capture: { video: true },
      vars: { keys: () => Object.keys(VALUES), isSecret: () => false, secretValues: () => [], get: (k) => VALUES[k] },
      redactor: createRedactor({ secrets: [], patterns: [] }),
    });
    const c = report.cases[0];
    expect(c?.verdict).toBe('passed');
    const dir = join(out, c?.dir ?? '');
    expect(c?.steps.map((s) => s.screenshot)).toEqual(['step-01.png', 'step-02.png', 'step-03.png', 'step-04.png']);
    for (const s of c?.steps ?? []) expect(statSync(join(dir, s.screenshot ?? '')).size).toBeGreaterThan(500);
    expect(c?.files?.map((f) => f.kind).sort()).toEqual(['console', 'log', 'network', 'trace', 'video']);
    for (const f of c?.files ?? []) expect(existsSync(join(dir, f.file))).toBe(true);
    const net = JSON.parse(readFileSync(join(dir, 'network.json'), 'utf8')) as { entries: Array<{ url: string; status: number }> };
    expect(net.entries.some((e) => e.url.includes('/shop') && e.status === 200)).toBe(true);
    // a zip starts with "PK"
    expect(readFileSync(join(dir, 'trace.zip')).subarray(0, 2).toString()).toBe('PK');
  });
});
