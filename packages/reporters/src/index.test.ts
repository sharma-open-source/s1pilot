import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RunReportSchema, type CaseRunResult, type RunReport } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { parseReporterList, parseRunReport, renderJson, renderJunit, validateJunit, writeReports } from './index.js';

const step = (index: number, over: Partial<CaseRunResult['steps'][number]> = {}): CaseRunResult['steps'][number] => ({
  index,
  action: `Step ${index + 1}`,
  verdict: 'passed',
  mode: 'replay',
  actions: 1,
  iterations: 1,
  durationMs: 100,
  assertions: [],
  decisions: [],
  ...over,
});

const caseResult = (over: Partial<CaseRunResult>): CaseRunResult => ({
  runId: 'run1',
  caseResultId: 'cr1',
  key: 'SHOP-TC-1',
  title: 'Add to cart',
  suite: 'SHOP',
  priority: 'P1',
  row: 1,
  mode: 'replay',
  verdict: 'passed',
  environment: 'local',
  browser: 'chromium',
  params: {},
  scriptKey: 'SHOP-TC-1#abc',
  dir: 'SHOP-TC-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  durationMs: 1500,
  healProposals: 0,
  steps: [step(0), step(1)],
  ...over,
});

const REPORT: RunReport = {
  runId: 'run1',
  environment: 'local',
  browser: 'chromium',
  mode: 'replay-heal',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:05.000Z',
  durationMs: 5000,
  totals: { passed: 1, failed: 1, blocked: 1, skipped: 0, flaky: 0, needsReview: 1 },
  steps: { executed: 6, passed: 4, successRate: 4 / 6 },
  cases: [
    caseResult({}),
    caseResult({
      caseResultId: 'cr2',
      key: 'SHOP-TC-2',
      title: 'Badge <count> & "quotes"',
      verdict: 'failed',
      mode: 'explore',
      steps: [
        step(0, { mode: 'explore' }),
        step(1, {
          verdict: 'failed',
          mode: 'explore',
          assertions: [{ assertion: 'elementText', verdict: 'fail', message: 'expected text(status) ⊇ "1", got "2"' }],
        }),
        step(2, { verdict: 'skipped', mode: undefined }),
      ],
    }),
    caseResult({
      caseResultId: 'cr3',
      key: 'SHOP-TC-3',
      title: 'Checkout',
      suite: 'PAY',
      verdict: 'blocked',
      steps: [step(0, { verdict: 'blocked', reason: 'Could not open http://x' })],
    }),
    caseResult({
      caseResultId: 'cr4',
      key: 'SHOP-TC-4',
      title: 'Search',
      suite: 'PAY',
      verdict: 'needs-review',
      label: 'blue / M',
      row: 2,
      steps: [step(0, { verdict: 'needs-review', assertions: [{ assertion: 'ai', verdict: 'needs-review', probability: 0.5 }] })],
    }),
  ],
};

const golden = (name: string): string => fileURLToPath(new URL(`../golden/${name}`, import.meta.url));

describe('renderJunit', () => {
  it('matches the golden file and validates against the JUnit structure', () => {
    const xml = renderJunit(REPORT);
    expect(validateJunit(xml)).toEqual([]);
    if (!existsSync(golden('junit.xml')) || process.env['UPDATE_GOLDEN']) writeFileSync(golden('junit.xml'), xml);
    expect(xml).toBe(readFileSync(golden('junit.xml'), 'utf8'));
  });

  it('puts the failed assertion into the failure message and escapes markup', () => {
    const xml = renderJunit(REPORT);
    expect(xml).toContain('message="step 2 (Step 2): expected text(status) ⊇ &quot;1&quot;, got &quot;2&quot;"');
    expect(xml).toContain('Badge &lt;count&gt; &amp; &quot;quotes&quot;');
  });

  it('reports needs-review as skipped by default and as a failure when configured', () => {
    expect(renderJunit(REPORT)).toContain('<skipped message="needs-review"/>');
    const strict = renderJunit(REPORT, { needsReview: 'failure' });
    expect(strict).not.toContain('<skipped');
    expect(strict).toContain('type="needs-review"');
    expect(validateJunit(strict)).toEqual([]);
  });

  it('groups testcases into one testsuite per suite with matching counters', () => {
    const xml = renderJunit(REPORT);
    expect(xml.match(/<testsuite /g)).toHaveLength(2);
    expect(xml).toContain('<testsuites name="s1pilot local" tests="4" failures="1" errors="1" skipped="1"');
  });

  it('the validator rejects broken documents', () => {
    expect(validateJunit('<testsuites tests="1" failures="0" errors="0" time="0.000"><testsuite name="a" tests="1" time="0"></testsuite></testsuites>').length).toBeGreaterThan(0);
    expect(() => validateJunit('<testsuites><testsuite></testsuites>')).toThrow();
  });
});

describe('renderJson', () => {
  it('writes the schema-valid full report incl. step results and decisions', () => {
    const json = renderJson(REPORT);
    expect(RunReportSchema.parse(JSON.parse(json))).toEqual(parseRunReport(REPORT));
    if (!existsSync(golden('report.json')) || process.env['UPDATE_GOLDEN']) writeFileSync(golden('report.json'), json);
    expect(json).toBe(readFileSync(golden('report.json'), 'utf8'));
  });

  it('refuses a report that violates the schema', () => {
    expect(() => renderJson({ ...REPORT, browser: 'netscape' } as unknown as RunReport)).toThrow();
  });
});

describe('writeReports', () => {
  it('writes the requested files and parses reporter lists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's1p-rep-'));
    const files = await writeReports(REPORT, dir, parseReporterList('junit, json,junit'));
    expect(files.map((f) => f.slice(dir.length + 1))).toEqual(['junit.xml', 'report.json']);
    expect(validateJunit(readFileSync(files[0] ?? '', 'utf8'))).toEqual([]);
    expect(() => parseReporterList('junit,html')).toThrow(/Unknown reporter "html"/);
  });
});
