/** Pure helpers of the review queue (S-047). */

export type ReviewTab = 'verdicts' | 'heals' | 'drafts' | 'visual';
export type ReviewStatusFilter = 'pending' | 'resolved';

export const TAB_LABEL: Record<ReviewTab, string> = {
  verdicts: 'Uncertain verdicts',
  heals: 'Heal proposals',
  drafts: 'Generated drafts',
  visual: 'Visual changes',
};

export const TABS: ReviewTab[] = ['verdicts', 'heals', 'drafts', 'visual'];

export const BROWSER_LABEL: Record<string, string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };

/** Parses the `tab` search param. */
export function parseTab(raw: unknown): ReviewTab | undefined {
  return TABS.find((t) => t === raw);
}

/** Parses the `status` search param. */
export function parseStatus(raw: unknown): ReviewStatusFilter | undefined {
  return raw === 'pending' || raw === 'resolved' ? raw : undefined;
}

/** Tab to show when the URL names none: the first with pending items, else uncertain verdicts. */
export function defaultTab(counts: Record<ReviewTab, number> | undefined): ReviewTab {
  return (counts && TABS.find((t) => counts[t] > 0)) || 'verdicts';
}

/** `Heal proposals · 3`. */
export function tabLabel(tab: ReviewTab, counts: Record<ReviewTab, number> | undefined): string {
  return `${TAB_LABEL[tab]} · ${counts?.[tab] ?? 0}`;
}

/** `Approve for all 6 cases`. */
export function approveAllLabel(n: number): string {
  return `Approve for all ${n} ${n === 1 ? 'case' : 'cases'}`;
}

/** Last 6 characters of a run id, shown after a hash sign. */
export function shortRun(id: string): string {
  return id.slice(-6);
}

/** Second line of a list entry. */
export function itemMeta(i: {
  tab: string;
  caseKey: string;
  stepNumber: number | null;
  confidence: number | null;
  sharedStepName: string | null;
  impactCount: number | null;
  environment: string;
  browser: string | null;
}): string {
  const conf = i.confidence !== null ? `${i.tab === 'heals' ? 'conf' : 'P(true)'} ${i.confidence.toFixed(2)}` : '';
  if (i.tab === 'heals') {
    const where =
      i.sharedStepName !== null
        ? `Shared step “${i.sharedStepName}” · used by ${i.impactCount ?? 1} ${i.impactCount === 1 ? 'case' : 'cases'}`
        : `${i.caseKey}${i.stepNumber !== null ? ` step ${i.stepNumber}` : ''}`;
    return [where, conf].filter(Boolean).join(' · ');
  }
  return [
    i.caseKey,
    i.environment,
    i.browser ? (BROWSER_LABEL[i.browser] ?? i.browser) : '',
    i.stepNumber !== null ? `step ${i.stepNumber}` : '',
    conf,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Wording of the S2 / live approval line of a heal. */
export function s2Line(s2Agreed: boolean | null, approvedLive: string | null): string {
  const s2 = s2Agreed === null ? 'S2 not consulted' : s2Agreed ? 'S2 agreed' : 'S2 disagreed';
  return approvedLive ? `${s2} · approved live by ${approvedLive}` : s2;
}

/** Thresholds sentence of the verdict detail. */
export function thresholdText(t: { pass: number; fail: number } | null): string {
  return t
    ? `Fail at or below ${t.fail.toFixed(2)}, pass at or above ${t.pass.toFixed(2)}; in between a person decides.`
    : 'No thresholds are configured for this project.';
}
