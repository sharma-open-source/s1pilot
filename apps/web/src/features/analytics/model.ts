/** Analytics views, in tab order. */
export const VIEWS = [
  ['quality', 'Quality'],
  ['readiness', 'Release readiness'],
  ['coverage', 'Coverage'],
  ['ai', 'AI model quality'],
] as const;
export type AnalyticsView = (typeof VIEWS)[number][0];

export const RANGES = [
  [7, 'Last 7 days'],
  [30, 'Last 30 days'],
  [90, 'Last 90 days'],
] as const;
export type Range = (typeof RANGES)[number][0];

/** URL search state shared by all views. */
export interface AnalyticsSearch {
  range?: Range;
  /** Environment name. */
  env?: string;
  /** Suite id. */
  suite?: string;
}

/** `validateSearch` of the analytics route: unknown or invalid values are dropped. */
export function parseSearch(raw: Record<string, unknown>): AnalyticsSearch {
  const range = Number(raw['range']);
  return {
    ...(range === 7 || range === 30 || range === 90 ? { range } : {}),
    ...(typeof raw['env'] === 'string' && raw['env'] !== '' ? { env: raw['env'] } : {}),
    ...(typeof raw['suite'] === 'string' && raw['suite'] !== '' ? { suite: raw['suite'] } : {}),
  };
}

/** The view for a `$view` route param (unknown values fall back to Quality). */
export function parseView(v: string): AnalyticsView {
  return VIEWS.find(([id]) => id === v)?.[0] ?? 'quality';
}

/** Milliseconds as `820 ms` / `2.4 s` / `1 m 05 s`. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')} s`;
}

/** Percentage with the decimal dropped when whole; `—` when there is no data. */
export function formatPct(v: number | null): string {
  return v === null ? '—' : `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}%`;
}

/** Flakiness score (0..1) as a percentage. */
export function flakinessPct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** Short `Oct 9` label for a `YYYY-MM-DD` day. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** RFC 4180 CSV; text cells that start like a spreadsheet formula get a leading `'`. */
export function toCsv(rows: Array<Array<string | number | null>>): string {
  const cell = (v: string | number | null): string => {
    let s = v === null ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/** Strokes for the pass-rate lines: neutral series, told apart by dash pattern as well as tone. */
export const LINE_STYLES = [
  { stroke: 'var(--chart-1)', dash: undefined },
  { stroke: 'var(--chart-2)', dash: '6 3' },
  { stroke: 'var(--chart-3)', dash: '2 3' },
] as const;
