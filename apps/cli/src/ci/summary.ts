/** Hidden marker that identifies the s1pilot comment on a pull request so it is updated, not duplicated. */
export const PR_COMMENT_MARKER = '<!-- s1pilot-run-summary -->';

/** Summary of a CI run, written to `<out>/ci-summary.json` and rendered into the PR comment. */
export interface CiSummary {
  /** Plan name (server mode) or the run target (standalone). */
  title: string;
  environment: string;
  /** Overall result. */
  outcome: 'passed' | 'failed' | 'needs-review' | 'error';
  exitCode: number;
  totals: { passed: number; failed: number; blocked: number; flaky: number; needsReview: number; skipped: number };
  /** Exit-criteria evaluation (server mode, plans with criteria). */
  criteria: { met: number; total: number; allMet: boolean; items: { label: string; met: boolean; actual?: string; detail?: string }[] } | null;
  /** Link to the run in the s1pilot UI (server mode). */
  reportUrl?: string;
  buildRef?: string;
  branch?: string;
}

const HEADLINE: Record<CiSummary['outcome'], string> = { passed: 'Passed', failed: 'Failed', 'needs-review': 'Needs review', error: 'Error' };

/** Escapes characters that would break a Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Renders the pull request comment body (summary table, exit criteria, report link). Deterministic. */
export function renderPrComment(summary: CiSummary): string {
  const t = summary.totals;
  const total = t.passed + t.failed + t.blocked + t.flaky + t.needsReview + t.skipped;
  const lines: string[] = [
    PR_COMMENT_MARKER,
    `### s1pilot: ${HEADLINE[summary.outcome]}`,
    '',
    `**${cell(summary.title)}** on \`${cell(summary.environment)}\`${summary.buildRef ? ` · build \`${cell(summary.buildRef)}\`` : ''}${summary.branch ? ` · branch \`${cell(summary.branch)}\`` : ''}`,
    '',
    '| Result | Cases |',
    '| --- | ---: |',
    `| Passed | ${t.passed} |`,
    `| Failed | ${t.failed} |`,
    `| Blocked | ${t.blocked} |`,
    `| Flaky | ${t.flaky} |`,
    `| Needs review | ${t.needsReview} |`,
    `| Skipped | ${t.skipped} |`,
    `| **Total** | **${total}** |`,
  ];
  if (summary.criteria) {
    lines.push('', `Exit criteria: ${summary.criteria.met} of ${summary.criteria.total} met`, '');
    for (const c of summary.criteria.items) {
      lines.push(`- ${c.met ? 'Met' : 'Not met'}: ${cell(c.label)}${c.actual ? ` (${cell(c.actual)})` : ''}`);
    }
  }
  if (summary.reportUrl) lines.push('', `[Open the full report](${summary.reportUrl})`);
  return `${lines.join('\n')}\n`;
}
