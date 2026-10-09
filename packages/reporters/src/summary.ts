import type { Redactor, RunReport } from '@s1pilot/domain';

import { REPORT_CSS } from './html/styles.js';

/** One exit criterion row of the summary. */
export interface SummaryCriterion {
  label: string;
  met: boolean;
  actual: string;
  detail: string;
}

/** Options of {@link renderSummaryHtml}. */
export interface SummaryOptions {
  /** Run / plan title shown in the heading. */
  title?: string;
  /** Evaluated exit criteria; omitted or empty renders "No exit criteria". */
  criteria?: readonly SummaryCriterion[];
  /** Release sign-off recorded on the run. */
  signOff?: { by: string; at: string; note: string } | null;
  redactor?: Redactor;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Renders the printable summary of a run (counts, exit criteria table, sign-off) as a self-contained HTML page.
 * Used as the source of the PDF export; has no scripts and no screenshots.
 */
export function renderSummaryHtml(report: RunReport, opts: SummaryOptions = {}): string {
  const { redactor } = opts;
  const r = (s: string): string => (redactor ? redactor.redact(s) : s);
  const t = report.totals;
  const criteria = opts.criteria ?? [];
  const unmet = criteria.filter((c) => !c.met).length;
  const tiles: Array<[string, number]> = [
    ['Passed', t.passed],
    ['Failed', t.failed],
    ['Needs review', t.needsReview],
    ['Flaky', t.flaky],
    ['Blocked', t.blocked],
    ['Skipped', t.skipped],
  ];
  const rows = criteria
    .map(
      (c) =>
        `<tr><td>${esc(r(c.label))}</td><td class="mono">${esc(r(c.actual))}</td><td><strong>${c.met ? 'Met' : 'Not met'}</strong></td><td>${esc(r(c.detail))}</td></tr>`,
    )
    .join('');
  const so = opts.signOff;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Run summary ${esc(report.runId)}</title>
<style>${REPORT_CSS}
body{padding:24px;max-width:900px;margin:0 auto}table.criteria{width:100%;border-collapse:collapse;margin-top:8px}
table.criteria th,table.criteria td{border:1px solid #D9D9D4;padding:8px;text-align:left;font-size:13px;vertical-align:top}
.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}.tile{border:1px solid #D9D9D4;border-radius:8px;padding:10px 14px;min-width:100px}
.tile .n{font-size:22px;font-weight:600}.mono{font-family:'IBM Plex Mono',monospace}
</style></head><body>
<h1>${esc(r(opts.title ?? 'Run summary'))}</h1>
<p class="mono">Run ${esc(report.runId)} · ${esc(r(report.environment))} · ${esc(report.startedAt)}</p>
<div class="tiles">${tiles.map(([l, n]) => `<div class="tile"><div>${l}</div><div class="n mono">${n}</div></div>`).join('')}</div>
<h2>Exit criteria${criteria.length > 0 ? ` · ${unmet} of ${criteria.length} not met` : ''}</h2>
${
  criteria.length === 0
    ? '<p>No exit criteria.</p>'
    : `<table class="criteria"><thead><tr><th>Criterion</th><th>Actual</th><th>Status</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>`
}
<h2>Sign-off</h2>
${so ? `<p>Signed off by <strong>${esc(r(so.by))}</strong> on ${esc(so.at)}.</p>${so.note ? `<p>${esc(r(so.note))}</p>` : ''}` : '<p>Not signed off.</p>'}
</body></html>
`;
}
