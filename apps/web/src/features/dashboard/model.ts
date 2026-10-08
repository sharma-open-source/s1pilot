import type { RouterOutputs } from '@/lib/trpc';

export type RecentRun = RouterOutputs['runs']['recent'][number];

const BROWSER_LABEL: Record<string, string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };

/** "Chromium", "Firefox", or "3 browsers" for several. */
export function browsersLabel(browsers: string[]): string | null {
  if (browsers.length === 0) return null;
  if (browsers.length === 1) return BROWSER_LABEL[browsers[0] as string] ?? (browsers[0] as string);
  return `${browsers.length} browsers`;
}

/** Step position of a running run, as far as the live socket has told us. */
export interface LiveStep {
  /** 1-based index of the step in progress; `null` until the first step starts. */
  current: number | null;
}

/**
 * Applies one `/ws/runs/:id` message (snapshot or event) to the live step position.
 * Unknown or malformed messages leave the state unchanged.
 */
export function applyRunMessage(state: LiveStep, raw: unknown): LiveStep {
  if (typeof raw !== 'object' || raw === null) return state;
  const msg = raw as Record<string, unknown>;
  if (msg['type'] === 'snapshot') {
    const steps = Array.isArray(msg['steps']) ? (msg['steps'] as Array<{ stepIndex?: unknown }>) : [];
    const last = steps.reduce((m, s) => (typeof s.stepIndex === 'number' ? Math.max(m, s.stepIndex) : m), -1);
    return { current: last >= 0 ? last + 1 : null };
  }
  if (msg['type'] === 'event' && typeof msg['event'] === 'object' && msg['event'] !== null) {
    const ev = msg['event'] as Record<string, unknown>;
    if (ev['type'] === 'case.started') return { current: null };
    if (ev['type'] === 'step.started' && typeof ev['stepIndex'] === 'number') return { current: ev['stepIndex'] + 1 };
  }
  return state;
}

/** Second line of a Recent runs row, e.g. `staging · Chromium · step 2/5` or `staging · 3 browsers · 2 failed`. */
export function runMeta(run: RecentRun, live: LiveStep): string {
  const parts: string[] = [];
  if (run.environment) parts.push(run.environment);
  const browsers = browsersLabel(run.browsers);
  if (browsers) parts.push(browsers);
  const { summary } = run;
  switch (run.status) {
    case 'running': {
      const total = run.activeCaseSteps;
      if (live.current !== null && total !== null) parts.push(`step ${Math.min(live.current, total)}/${total}`);
      else if (live.current !== null) parts.push(`step ${live.current}`);
      else parts.push('starting');
      break;
    }
    case 'queued':
      parts.push('waiting for a worker');
      break;
    case 'failed':
      parts.push(`${summary.failed + summary.blocked} failed`);
      break;
    case 'needs-review':
      parts.push(`${summary.needsReview} need review`);
      break;
    case 'cancelled':
      parts.push('cancelled');
      break;
    case 'passed':
      parts.push(run.mode === 'replay-only' ? 'replay mode' : `${summary.passed} passed`);
      break;
  }
  return parts.join(' · ');
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"; `null` timestamps read as "Never". */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Never';
  const diff = now - Date.parse(iso);
  if (!Number.isFinite(diff)) return 'Never';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
