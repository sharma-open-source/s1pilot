import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRedactor, type CaseRunResult, type RunReport } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { writeReports } from '../index.js';

import { renderHtml } from './render.js';

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

const kase = (over: Partial<CaseRunResult>): CaseRunResult => ({
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
  steps: [step(0)],
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
  totals: { passed: 1, failed: 1, blocked: 0, skipped: 0, flaky: 0, needsReview: 1 },
  steps: { executed: 4, passed: 2, successRate: 0.5 },
  cases: [
    kase({}),
    kase({
      caseResultId: 'cr2',
      key: 'SHOP-TC-2',
      title: 'Badge <count> & "quotes"',
      verdict: 'failed',
      dir: 'SHOP-TC-2',
      steps: [
        step(0, {
          verdict: 'failed',
          assertions: [{ assertion: 'elementText', verdict: 'fail', message: 'expected text(status) ⊇ "1", got "2"' }],
          decisions: [
            {
              questionId: 'pick-element',
              options: ['#add', '#buy'],
              probabilities: { '#add': 0.9, '#buy': 0.1 },
              chosen: '#add',
              confidence: 0.9,
              model: 'mock',
              latencyMs: 12,
            },
          ],
        }),
      ],
    }),
    kase({
      caseResultId: 'cr3',
      key: 'SHOP-TC-3',
      title: 'Search',
      verdict: 'needs-review',
      dir: 'SHOP-TC-3',
      steps: [step(0, { verdict: 'needs-review', assertions: [{ assertion: 'ai', verdict: 'needs-review', probability: 0.5 }] })],
    }),
  ],
};

const golden = fileURLToPath(new URL('../../golden/report.html', import.meta.url));

describe('renderHtml', () => {
  it('matches the golden structure snapshot', async () => {
    const html = await renderHtml(REPORT);
    if (!existsSync(golden) || process.env['UPDATE_GOLDEN']) writeFileSync(golden, html);
    expect(html).toBe(readFileSync(golden, 'utf8'));
  });

  it('has the summary tiles, filters, pills and decision bars and escapes markup', async () => {
    const html = await renderHtml(REPORT);
    for (const label of ['Passed', 'Failed', 'Needs review', 'Flaky / Blocked']) expect(html).toContain(`>${label}</div>`);
    expect(html).toContain('data-filter="failed"');
    expect(html).toContain('data-filter="review"');
    expect(html).toContain('data-filter="all"');
    expect(html).toContain('class="pill pill-passed">Passed');
    expect(html).toContain('class="pill pill-failed">Failed');
    expect(html).toContain('class="pill pill-needs-review">Review');
    expect(html).toContain('style="width:90.0%"');
    expect(html).toContain('Badge &lt;count&gt; &amp; &quot;quotes&quot;');
    // no JS needed to read: every case expanded
    expect(html.match(/<details class="case" open/g)).toHaveLength(3);
  });

  it('maps status pills to the design.md §2.2 colour tokens', async () => {
    const html = await renderHtml(REPORT);
    expect(html).toContain('.pill-passed{background:var(--success-soft);color:var(--success)}');
    expect(html).toContain('.pill-failed{background:var(--danger-soft);color:var(--danger)}');
    expect(html).toContain('.pill-needs-review{background:var(--warning-soft);color:var(--warning)}');
    expect(html).toContain('.pill-flaky{background:var(--flaky-soft);color:var(--flaky)}');
    expect(html).toContain('.pill-blocked,.pill-skipped{background:var(--surface-muted);color:var(--text-strong-2)}');
  });

  it('references no external URLs except the optional Google Fonts link', async () => {
    const html = await renderHtml(REPORT);
    expect(html).not.toMatch(/(?:src|href)="https?:/);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/);
    const fonts = await renderHtml(REPORT, { googleFonts: true });
    const urls = fonts.match(/(?:src|href)="https?:[^"]*"/g) ?? [];
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('fonts.googleapis.com');
  });

  it('contains no seeded secret value', async () => {
    const secret = 'hunter2-S3CRET';
    const leaky: RunReport = {
      ...REPORT,
      cases: [kase({ title: `login ${secret}`, steps: [step(0, { action: `type ${secret}`, reason: `got ${secret}`, assertions: [{ assertion: 'x', verdict: 'fail', message: secret }] })] })],
    };
    const html = await renderHtml(leaky, { redactor: createRedactor({ secrets: [secret], patterns: [] }) });
    expect(html).not.toContain(secret);
    expect(html).toContain('[REDACTED]');
  });

  it('inlines screenshots as data URIs and links them once the cap is exceeded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's1p-html-'));
    mkdirSync(join(dir, 'SHOP-TC-1'));
    writeFileSync(join(dir, 'SHOP-TC-1', 'step-1.png'), Buffer.alloc(100, 1));
    const inline = await renderHtml(REPORT, { resultsDir: dir });
    expect(inline).toContain('src="data:image/png;base64,');
    const capped = await renderHtml(REPORT, { resultsDir: dir, inlineCapBytes: 50 });
    expect(capped).not.toContain('data:image/png');
    expect(capped).toContain('href="SHOP-TC-1/step-1.png"');
  });

  it('writeReports writes report.html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's1p-html-'));
    const [file] = await writeReports(REPORT, dir, ['html']);
    expect(file?.endsWith('report.html')).toBe(true);
    expect(readFileSync(file ?? '', 'utf8')).toContain('<title>Run report run1</title>');
  });
});
