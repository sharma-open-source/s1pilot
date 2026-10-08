import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { CaseRunResult, Redactor, RunReport, StepReport } from '@s1pilot/domain';

import { REPORT_CSS, REPORT_JS } from './styles.js';

/** Total bytes of screenshots that may be inlined as data URIs. */
export const HTML_INLINE_CAP_BYTES = 15 * 1024 * 1024;

/** Options of {@link renderHtml}. */
export interface HtmlOptions {
  /** Applied to every text before it is written (build from the run's resolved secrets). */
  redactor?: Redactor;
  /** The run's output directory; screenshots are looked up in `<resultsDir>/<case.dir>/`. */
  resultsDir?: string;
  /** Override screenshot discovery: file paths for a step. */
  screenshots?: (c: CaseRunResult, step: StepReport) => string[] | Promise<string[]>;
  /** Inline cap in bytes (default 15 MB); beyond it screenshots are linked, not inlined. */
  inlineCapBytes?: number;
  /** Adds the optional Google Fonts stylesheet link (default false: fully offline). */
  googleFonts?: boolean;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Pill label per verdict (design.md §2.2). */
const LABEL: Record<string, string> = {
  passed: 'Passed',
  failed: 'Failed',
  'needs-review': 'Review',
  flaky: 'Flaky',
  blocked: 'Blocked',
  skipped: 'Skipped',
};

const pill = (verdict: string): string => `<span class="pill pill-${esc(verdict)}">${esc(LABEL[verdict] ?? verdict)}</span>`;

async function defaultScreenshots(resultsDir: string, c: CaseRunResult, step: StepReport): Promise<string[]> {
  const dir = join(resultsDir, c.dir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^(?:step-?)?0*${step.index + 1}(?:[-_.].*)?\\.(png|jpe?g|webp)$`, 'i');
  return names
    .filter((f) => re.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Renders a self-contained, offline HTML report for a run (mirrors the Run report screen,
 * wireframe 07). Screenshots are inlined as data URIs up to the cap, then linked by path.
 */
export async function renderHtml(report: RunReport, opts: HtmlOptions = {}): Promise<string> {
  const cap = opts.inlineCapBytes ?? HTML_INLINE_CAP_BYTES;
  let inlined = 0;
  const r = (s: string): string => esc(opts.redactor ? opts.redactor.redact(s) : s);

  async function shots(c: CaseRunResult, step: StepReport): Promise<string> {
    const files = opts.screenshots
      ? await opts.screenshots(c, step)
      : opts.resultsDir
        ? await defaultScreenshots(opts.resultsDir, c, step)
        : [];
    const items: string[] = [];
    for (const file of files) {
      const mime = MIME[extname(file).toLowerCase()];
      if (!mime) continue;
      const size = (await stat(file)).size;
      const label = `Screenshot, step ${step.index + 1}`;
      if (inlined + size <= cap) {
        inlined += size;
        const data = (await readFile(file)).toString('base64');
        items.push(`<img alt="${esc(label)}" src="data:${mime};base64,${data}">`);
      } else {
        const name = file.split(/[\\/]/).pop() ?? '';
        const href = opts.resultsDir ? `${encodeURI(c.dir)}/${encodeURI(name)}` : encodeURI(file);
        items.push(`<a href="${esc(href)}">${esc(label)} (linked, over size cap)</a>`);
      }
    }
    return items.length ? `<div class="shots">${items.join('')}</div>` : '';
  }

  function bars(step: StepReport): string {
    return step.decisions
      .map((d) => {
        const rows = d.options
          .map((o) => {
            const p = d.probabilities[o] ?? 0;
            return `<div class="bar${d.chosen === o ? ' sel' : ''}"><span class="lab">${r(o)}</span><span class="track"><span class="fill" style="width:${(p * 100).toFixed(1)}%"></span></span><span class="pct">${(p * 100).toFixed(1)}%</span></div>`;
          })
          .join('');
        const head = `${r(d.questionId)} &middot; ${r(d.model)} &middot; ${d.latencyMs} ms${d.escalatedTo ? ` &middot; escalated to ${r(d.escalatedTo)}` : ''}`;
        return `<div class="box"><b>Decision</b><span class="mono">${head}</span>${rows}</div>`;
      })
      .join('');
  }

  async function stepHtml(c: CaseRunResult, s: StepReport): Promise<string> {
    const bad = s.assertions.filter((a) => a.verdict !== 'pass');
    const actual = s.actionTaken ?? s.reason ?? (bad[0] ? (bad[0].message ?? bad[0].assertion) : '');
    const expected = s.assertions.find((a) => a.assertion === 'expected')?.message;
    const asr = s.assertions.length
      ? `<ul class="asr">${s.assertions
          .map(
            (a) =>
              `<li class="${a.verdict === 'pass' ? '' : 'fail'}"><span class="mono">${r(a.assertion)}</span> &middot; ${esc(a.verdict)}${a.probability !== undefined ? ` &middot; <span class="mono">p=${a.probability.toFixed(2)}</span>` : ''}${a.message ? ` &mdash; ${r(a.message)}` : ''}</li>`,
          )
          .join('')}</ul>`
      : '';
    return `<div class="step"><div class="step-h">${pill(s.verdict)}<span><span class="mono">${s.index + 1}.</span> ${r(s.action)}</span>${s.mode ? `<span class="mono">[${esc(s.mode)}]</span>` : ''}<span class="dur">${s.durationMs} ms</span></div>
<div class="box"><b>Expected</b>${expected ? r(expected) : '<span class="empty">see assertions</span>'}<b>Actual</b>${actual ? r(actual) : '<span class="empty">&mdash;</span>'}${asr}</div>${bars(s)}${await shots(c, s)}</div>`;
  }

  async function caseHtml(c: CaseRunResult): Promise<string> {
    const steps = (await Promise.all(c.steps.map((s) => stepHtml(c, s)))).join('');
    const title = `${r(c.title)}${c.label ? ` (${r(c.label)})` : ''}`;
    return `<details class="case" open data-verdict="${esc(c.verdict)}"><summary>${pill(c.verdict)}<span class="key">${r(c.key)}</span><span>${title}</span><span class="dur">${esc(c.mode)} &middot; ${c.durationMs} ms</span></summary><div class="body">${steps || '<p class="empty">No steps recorded.</p>'}</div></details>`;
  }

  const t = report.totals;
  const tiles = (
    [
      ['Passed', t.passed],
      ['Failed', t.failed],
      ['Needs review', t.needsReview],
      ['Flaky / Blocked', t.flaky + t.blocked],
    ] as const
  )
    .map(([l, n]) => `<div class="tile"><div class="n">${n}</div><div class="l">${l}</div></div>`)
    .join('');
  const cases = (await Promise.all(report.cases.map(caseHtml))).join('\n');
  const fonts = opts.googleFonts
    ? '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">\n'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Run report ${r(report.runId)}</title>
${fonts}<style>${REPORT_CSS}</style>
</head>
<body>
<main>
<h1>Run report</h1>
<p class="meta"><span class="mono">${r(report.runId)}</span> &middot; ${r(report.environment)} &middot; ${esc(report.browser)} &middot; ${esc(report.mode)} &middot; <span class="mono">${esc(report.startedAt)}</span> &middot; ${report.durationMs} ms &middot; step success ${(report.steps.successRate * 100).toFixed(0)}%</p>
<section aria-label="Summary" class="tiles">${tiles}</section>
<div class="filters" role="group" aria-label="Filter results"><button type="button" data-filter="failed" aria-pressed="false">Failed</button><button type="button" data-filter="review" aria-pressed="false">Review</button><button type="button" data-filter="all" aria-pressed="true">All</button></div>
<section aria-label="Results">
<h2>Results</h2>
${cases || '<p class="empty">No cases in this run.</p>'}
</section>
</main>
<script>${REPORT_JS}</script>
</body>
</html>
`;
}
