import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EnvironmentSchema,
  TestCaseSchema,
  checkConfigFromPlan,
  createRedactor,
  newId,
  type CheckConfig,
  type CheckResult,
  type PlanChecks,
  type TestCase,
} from '@s1pilot/domain';
import { startFixtureServer, type FixtureServer } from '@s1pilot/fixture-sites';
import { MockDecisionModel, mockResolver } from '@s1pilot/providers';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CaseChecks } from './checks.js';
import { runCases, type RunCasesInput } from './run-cases.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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

const redactor = createRedactor({ secrets: [], patterns: [] });
const tmp = (): string => mkdtempSync(join(tmpdir(), 's1p-checks-'));
const plan = (over: Partial<PlanChecks> = {}): PlanChecks => ({ a11y: true, consoleErrors: false, visual: false, video: false, ...over });

const testCase: TestCase = TestCaseSchema.parse({
  id: newId(),
  projectId: newId(),
  key: 'Q-1',
  title: 'Newsletter page',
  priority: 'P2',
  type: 'e2e',
  status: 'ready',
  steps: [{ action: 'Look at the newsletter page', expected: 'The newsletter form is shown' }],
});

function run(query: string, config: CheckConfig, extra: Partial<RunCasesInput> = {}) {
  const s1 = new MockDecisionModel({
    fallback: mockResolver({ steps: { 'Look at the newsletter page': [] }, inputs: {}, expected: 0.95 }),
  });
  const environment = EnvironmentSchema.parse({ id: newId(), projectId: newId(), name: 'local', baseUrl: `${server.url}/quality${query}` });
  const out = tmp();
  return runCases({
    cases: [testCase],
    environment,
    browser,
    browserName: 'chromium',
    models: { s1, thresholds: { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 }, modelName: 'mock' },
    out,
    vars: { keys: () => [], isSecret: () => false, secretValues: () => [], get: () => undefined },
    redactor,
    checks: config,
    ...extra,
  }).then((report) => ({ report, out }));
}

const kind = (checks: CheckResult[] | undefined, k: string): CheckResult | undefined => checks?.find((c) => c.kind === k);

describe('CaseChecks via runCases', () => {
  it('reports a missing form label as an a11y violation (rule label) that fails the case', async () => {
    const { report, out } = await run('?label=missing', checkConfigFromPlan(plan()));
    const c = report.cases[0];
    expect(c?.steps.every((s) => s.verdict === 'passed')).toBe(true);
    const a11y = kind(c?.checks, 'a11y');
    expect(a11y?.items.map((i) => i.ruleId)).toContain('label');
    const label = a11y?.items.find((i) => i.ruleId === 'label');
    expect(label?.impact).toBe('critical');
    expect(label?.target).toContain('input');
    expect(label?.helpUrl).toMatch(/^https:\/\//);
    expect(a11y?.severity).toBe('fail');
    expect(c?.verdict).toBe('failed');
    expect(c?.files?.some((f) => f.file === 'checks.json')).toBe(true);
    expect(existsSync(join(out, 'Q-1', 'checks.json'))).toBe(true);
    expect((JSON.parse(readFileSync(join(out, 'Q-1', 'checks.json'), 'utf8')) as CheckResult[])[0]?.kind).toBe('a11y');
  });

  it('a clean page passes all checks; lower impacts only warn; disabled rules are skipped', async () => {
    const clean = await run('', checkConfigFromPlan(plan()));
    expect(clean.report.cases[0]?.verdict).toBe('passed');
    expect(clean.report.cases[0]?.checks?.map((c) => c.severity)).toEqual(['pass', 'pass', 'pass']);

    // With the threshold raised above `critical`'s level the violation cannot fail: critical is the maximum, so use disabled rules.
    const disabled = await run('?label=missing', checkConfigFromPlan(plan({ a11yDisabledRules: ['label'] })));
    expect(kind(disabled.report.cases[0]?.checks, 'a11y')?.items.map((i) => i.ruleId)).not.toContain('label');

    const warnOnly = await run('?label=missing', { ...checkConfigFromPlan(plan()), a11y: { failImpact: 'critical', disabledRules: ['label'] } });
    expect(warnOnly.report.cases[0]?.verdict).toBe('passed');
  });

  it('a console error fails the case when "fail on console errors" is on and only warns when off', async () => {
    const off = await run('?console=error', checkConfigFromPlan(plan({ a11y: false, consoleErrors: false })));
    const warn = kind(off.report.cases[0]?.checks, 'console');
    expect(off.report.cases[0]?.verdict).toBe('passed');
    expect(warn?.severity).toBe('warn');
    expect(warn?.items.map((i) => i.summary).join('\n')).toContain('Fixture console failure');

    const on = await run('?console=error', checkConfigFromPlan(plan({ a11y: false, consoleErrors: true })));
    expect(on.report.cases[0]?.verdict).toBe('failed');
    expect(kind(on.report.cases[0]?.checks, 'console')?.severity).toBe('fail');
    expect(kind(on.report.cases[0]?.checks, 'a11y')).toBeUndefined();
  });

  it('honours the console allow-list', async () => {
    const { report } = await run('?console=error', checkConfigFromPlan(plan({ a11y: false, consoleErrors: true, consoleAllow: ['Fixture (console|uncaught)'] })));
    expect(report.cases[0]?.verdict).toBe('passed');
    expect(kind(report.cases[0]?.checks, 'console')?.items).toEqual([]);
  });

  it('flags 5xx responses as network failures', async () => {
    const { report } = await run('?status=503', checkConfigFromPlan(plan({ a11y: false, consoleErrors: true })));
    const net = kind(report.cases[0]?.checks, 'network');
    expect(net?.items.some((i) => i.status === 503)).toBe(true);
    expect(report.cases[0]?.verdict).toBe('failed');
    const allowed = await run('?status=503', checkConfigFromPlan(plan({ a11y: false, consoleErrors: true, networkAllow: ['/api/health'] })));
    expect(allowed.report.cases[0]?.verdict).toBe('passed');
  });

  it('runs no checks without a config', async () => {
    const { report } = await run('?label=missing', checkConfigFromPlan(plan()), { checks: undefined as never });
    expect(report.cases[0]?.checks).toBeUndefined();
    expect(report.cases[0]?.verdict).toBe('passed');
  });
});

describe('CaseChecks', () => {
  it('scans a page once per fingerprint', async () => {
    const context = await browser.newContext();
    const checks = new CaseChecks(checkConfigFromPlan(plan()), server.url, redactor);
    checks.attach(context);
    const page = await context.newPage();
    await page.goto(`${server.url}/quality?label=missing`);
    await checks.afterStep(page, 0);
    await checks.afterStep(page, 1);
    await checks.afterStep(page, 2);
    expect(checks.scans).toBe(1);
    await page.goto(`${server.url}/quality/`);
    await checks.afterStep(page, 3);
    expect(checks.scans).toBe(2);
    await context.close();
  });
});
