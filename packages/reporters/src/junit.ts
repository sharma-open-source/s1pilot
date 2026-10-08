import type { CaseRunResult, RunReport, StepReport } from '@s1pilot/domain';

/** Options of {@link renderJunit}. */
export interface JunitOptions {
  /**
   * How `needs-review` cases appear: `skipped` (default) emits `<skipped message="needs-review"/>`
   * so CI does not go red for cases waiting on a human; `failure` emits a `<failure>`.
   */
  needsReview?: 'skipped' | 'failure';
}

// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Removes characters XML 1.0 cannot carry and escapes the markup characters (for attribute values). */
export function escapeXml(text: string): string {
  return text
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
    .replace(/\t/g, '&#9;');
}

/** Escapes element text (newlines stay literal). */
function escapeText(text: string): string {
  return text.replace(INVALID_XML_CHARS, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const secs = (ms: number): string => (ms / 1000).toFixed(3);

/** One-line summary of why a step did not pass: the first failed assertion, else the engine's reason. */
function stepSummary(step: StepReport): string {
  const bad = step.assertions.find((a) => a.verdict !== 'pass');
  const text = bad ? (bad.message ?? bad.assertion) : (step.reason ?? `step ${step.verdict}`);
  return `step ${step.index + 1} (${step.action}): ${text}`;
}

/** The message of a failure: the first non-passing step's summary. */
function failureMessage(c: CaseRunResult): string {
  const step = c.steps.find((s) => s.verdict !== 'passed' && s.verdict !== 'skipped');
  return step ? stepSummary(step) : `case ${c.verdict}`;
}

function caseBody(c: CaseRunResult): string {
  return c.steps
    .map((s) => {
      const head = `${s.verdict.padEnd(12)} ${s.index + 1}. ${s.action}${s.mode ? ` [${s.mode}]` : ''}`;
      const notes = [
        ...(s.reason ? [`    ${s.reason}`] : []),
        ...s.assertions.filter((a) => a.verdict !== 'pass').map((a) => `    ${a.verdict}: ${a.message ?? a.assertion}`),
      ];
      return [head, ...notes].join('\n');
    })
    .join('\n');
}

function testcase(c: CaseRunResult, opts: Required<JunitOptions>): string {
  const name = `${c.key} ${c.title}${c.label ? ` [${c.label}]` : ''}`;
  const attrs = `classname="${escapeXml(c.suite)}" name="${escapeXml(name)}" time="${secs(c.durationMs)}"`;
  const body = caseBody(c);
  // Failures carry the step log in their own text; everything else gets it as system-out.
  const failing = c.verdict === 'failed' || c.verdict === 'flaky' || c.verdict === 'blocked';
  const out = body && !failing ? `\n      <system-out>${escapeText(body)}</system-out>` : '';
  let status = '';
  switch (c.verdict) {
    case 'passed':
      break;
    case 'skipped':
      status = '\n      <skipped/>';
      break;
    case 'needs-review':
      status =
        opts.needsReview === 'skipped'
          ? '\n      <skipped message="needs-review"/>'
          : `\n      <failure message="${escapeXml(`needs-review: ${failureMessage(c)}`)}" type="needs-review">${escapeText(body)}</failure>`;
      break;
    case 'blocked':
      status = `\n      <error message="${escapeXml(failureMessage(c))}" type="blocked">${escapeText(body)}</error>`;
      break;
    default:
      status = `\n      <failure message="${escapeXml(failureMessage(c))}" type="${c.verdict}">${escapeText(body)}</failure>`;
  }
  return `    <testcase ${attrs}>${status}${out}\n    </testcase>`;
}

/** Counters of one suite in JUnit terms. */
function counts(cases: CaseRunResult[], needsReview: Required<JunitOptions>['needsReview']): { failures: number; errors: number; skipped: number } {
  const n = (f: (c: CaseRunResult) => boolean): number => cases.filter(f).length;
  return {
    failures: n((c) => c.verdict === 'failed' || c.verdict === 'flaky' || (c.verdict === 'needs-review' && needsReview === 'failure')),
    errors: n((c) => c.verdict === 'blocked'),
    skipped: n((c) => c.verdict === 'skipped' || (c.verdict === 'needs-review' && needsReview === 'skipped')),
  };
}

/**
 * Renders a run as JUnit XML: one `<testsuite>` per suite, one `<testcase>` per case instance.
 * `failed` / `flaky` become `<failure>` (message = the first failed assertion), `blocked` becomes
 * `<error>`, `skipped` and (by default) `needs-review` become `<skipped>`.
 */
export function renderJunit(report: RunReport, options: JunitOptions = {}): string {
  const opts: Required<JunitOptions> = { needsReview: options.needsReview ?? 'skipped' };
  const suites = new Map<string, CaseRunResult[]>();
  for (const c of report.cases) suites.set(c.suite, [...(suites.get(c.suite) ?? []), c]);
  const total = counts(report.cases, opts.needsReview);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(`s1pilot ${report.environment}`)}" tests="${report.cases.length}" failures="${total.failures}" errors="${total.errors}" skipped="${total.skipped}" time="${secs(report.durationMs)}">`,
  ];
  for (const [name, cases] of suites) {
    const c = counts(cases, opts.needsReview);
    const time = cases.reduce((sum, x) => sum + x.durationMs, 0);
    lines.push(
      `  <testsuite name="${escapeXml(name)}" tests="${cases.length}" failures="${c.failures}" errors="${c.errors}" skipped="${c.skipped}" time="${secs(time)}" timestamp="${escapeXml(report.startedAt.replace(/\.\d+Z$/, ''))}">`,
      ...cases.map((x) => testcase(x, opts)),
      '  </testsuite>',
    );
  }
  lines.push('</testsuites>', '');
  return lines.join('\n');
}
