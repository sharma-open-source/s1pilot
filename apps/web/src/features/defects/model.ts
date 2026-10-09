import { BROWSER_LABEL } from '../review/model';

/** URL search state of `/p/:key/defects`. */
export interface DefectsSearch {
  /** Filter query (`status:open`). */
  q?: string;
  /** Selected defect id. */
  defect?: string;
  /** Result to prefill the new-defect form from. */
  fromResult?: string;
  /** Manual execution item to prefill the new-defect form from (S-055); uses `step` like `fromResult`. */
  fromManual?: string;
  /** 0-based failing step of `fromResult` / `fromManual`. */
  step?: number;
  /** Open an empty new-defect form (optionally with `title` / `source`). */
  new?: boolean;
  title?: string;
  source?: string;
}

/** Statuses in lifecycle order, with their labels. */
export const STATUSES = [
  ['draft', 'Draft'],
  ['open', 'Open'],
  ['in-progress', 'In progress'],
  ['fixed', 'Fixed'],
  ['closed', 'Closed'],
] as const;

export const SEVERITIES = [
  ['S1', 'S1 · Critical'],
  ['S2', 'S2 · Major'],
  ['S3', 'S3 · Minor'],
  ['S4', 'S4 · Trivial'],
] as const;

/** `S2 · Major` for a severity code. */
export function severityLabel(s: string): string {
  return SEVERITIES.find(([v]) => v === s)?.[1] ?? s;
}

/** Tag tone: S1 / S2 danger, S3 warning, S4 neutral. */
export function severityTone(s: string): 'danger' | 'warning' | 'neutral' {
  return s === 'S1' || s === 'S2' ? 'danger' : s === 'S3' ? 'warning' : 'neutral';
}

/** `WebKit, Firefox`, or `–` when no result is linked. */
export function failingLabel(browsers: string[]): string {
  return browsers.length === 0 ? '–' : browsers.map((b) => BROWSER_LABEL[b] ?? b).join(', ');
}

/** Status text of a row; `Fixed · re-test queued` once the automatic re-test was started. */
export function statusText(status: string, retestRunId: string | null): string {
  const label = STATUSES.find(([v]) => v === status)?.[1] ?? status;
  return (status === 'fixed' || status === 'closed') && retestRunId ? `${label} · re-test queued` : label;
}

/** `staging · WebKit` line of the attachments row. */
export function environmentLine(environment: string | undefined, browser: string | undefined): string {
  return [environment, browser ? (BROWSER_LABEL[browser] ?? browser) : undefined].filter(Boolean).join(' · ');
}

/** Short build ref (first 7 characters of a sha). */
export function shortSha(ref: string): string {
  return /^[0-9a-f]{12,}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

/** Parses the route's search params. */
export function parseSearch(search: Record<string, unknown>): DefectsSearch {
  const str = (k: string): string | undefined => (typeof search[k] === 'string' && search[k] !== '' ? (search[k] as string) : undefined);
  const stepRaw = search['step'];
  const step = typeof stepRaw === 'number' ? stepRaw : typeof stepRaw === 'string' && /^\d+$/.test(stepRaw) ? Number(stepRaw) : undefined;
  const q = str('q');
  const defect = str('defect');
  const fromResult = str('fromResult');
  const fromManual = str('fromManual');
  const title = str('title');
  const source = str('source');
  return {
    ...(q ? { q } : {}),
    ...(defect ? { defect } : {}),
    ...(fromResult ? { fromResult } : {}),
    ...(fromManual ? { fromManual } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(search['new'] === true || search['new'] === 'true' || search['new'] === 1 ? { new: true } : {}),
    ...(title ? { title } : {}),
    ...(source ? { source } : {}),
  };
}
