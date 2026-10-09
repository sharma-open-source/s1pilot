import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EnvironmentSchema, checkConfigFromPlan, createRedactor, newId } from '@s1pilot/domain';
import { startFixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, loadMockScript, mockResolver } from '@s1pilot/providers';
import { loadCaseFile } from '@s1pilot/sync';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';

import { runCases } from './run-cases.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });
const casesDir = fileURLToPath(new URL('../../../fixtures/sites/cases/shop/', import.meta.url));

it('adds less than 30% to a fixture run with per-fingerprint scanning', async () => {
  const server = await startFixtureServer();
  const browser = await chromium.launch();
  const values: Record<string, string> = { search_term: 't-shirt', shipping_name: 'Alex Doe', shipping_zip: '94105' };
  const timed = async (checks: boolean): Promise<number> => {
    const started = Date.now();
    const report = await runCases({
      cases: [loadCaseFile(join(casesDir, 'tc-042.yaml'))],
      environment: EnvironmentSchema.parse({ id: newId(), projectId: newId(), name: 'local', baseUrl: `${server.url}/shop` }),
      browser,
      browserName: 'chromium',
      models: {
        s1: new MockDecisionModel({ fallback: mockResolver(loadMockScript(join(casesDir, 'tc-042.mock.json'))) }),
        thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 },
        modelName: 'mock',
      },
      out: mkdtempSync(join(tmpdir(), 's1p-overhead-')),
      vars: { keys: () => Object.keys(values), isSecret: () => false, secretValues: () => [], get: (k) => values[k] },
      redactor: createRedactor({ secrets: [], patterns: [] }),
      ...(checks ? { checks: checkConfigFromPlan({ a11y: true, consoleErrors: true, visual: false, video: false }) } : {}),
    });
    expect(report.cases[0]?.verdict).toBe('passed');
    return Date.now() - started;
  };
  try {
    await timed(false); // warm-up
    const off = Math.min(await timed(false), await timed(false));
    const on = Math.min(await timed(true), await timed(true));
    expect(on).toBeLessThan(off * 1.3);
  } finally {
    await browser.close();
    await server.close();
  }
});
