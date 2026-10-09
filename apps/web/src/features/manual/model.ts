/** Verdicts a tester can record for a step, with their button labels. */
export const VERDICTS = [
  ['pass', 'Pass'],
  ['fail', 'Fail'],
  ['blocked', 'Blocked'],
  ['na', 'N/A'],
] as const;

export type StepVerdict = (typeof VERDICTS)[number][0];

/** `mm:ss`, or `h:mm:ss` from one hour on. */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Label of a recorded verdict. */
export function verdictLabel(v: StepVerdict): string {
  return VERDICTS.find(([id]) => id === v)?.[1] ?? v;
}

/** Past-tense label of a recorded verdict for the step pill (`Passed`, `Failed`, `Blocked`, `N/A`). */
export function verdictPillLabel(v: StepVerdict): string {
  return v === 'pass' ? 'Passed' : v === 'fail' ? 'Failed' : v === 'blocked' ? 'Blocked' : 'N/A';
}

/** Pill tone of a recorded verdict. */
export function verdictTone(v: StepVerdict): 'success' | 'danger' | 'neutral' {
  return v === 'pass' ? 'success' : v === 'fail' ? 'danger' : 'neutral';
}

/** `Passed` / `Failed` / ... for an AI pre-run step status. */
export function preRunLabel(status: string): string {
  return status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : status === 'blocked' ? 'blocked' : 'skipped';
}

/** Status of a queue row as shown in My queue. */
export function queueStatusLabel(status: string, verdict: string | null): string {
  if (status === 'done') return verdict === 'failed' ? 'Failed' : verdict === 'blocked' ? 'Blocked' : verdict === 'skipped' ? 'Skipped' : 'Passed';
  if (status === 'skipped') return 'Skipped';
  return status === 'in-progress' ? 'In progress' : 'To do';
}

/** Pill status key (see `STATUS_PILLS`) of a queue row. */
export function queueStatusKey(status: string, verdict: string | null): string {
  if (status === 'done') return verdict === 'failed' ? 'failed' : verdict === 'blocked' ? 'blocked' : verdict === 'skipped' ? 'skipped' : 'passed';
  if (status === 'skipped') return 'skipped';
  return status === 'in-progress' ? 'in-progress' : 'to-do';
}

/** Index of the step the tester works on: the explicit selection, else the first step still open. */
export function currentStepIndex(
  steps: { verdict: string | null; preRun: string | null; confirmed: boolean }[],
  redo: ReadonlySet<number>,
  selected: number | undefined,
): number | undefined {
  if (selected !== undefined && selected < steps.length) return selected;
  const awaitingConfirm = (i: number): boolean => steps[i]?.preRun != null && steps[i]?.verdict == null && !redo.has(i);
  const idx = steps.findIndex((s, i) => s.verdict == null && !awaitingConfirm(i));
  return idx === -1 ? undefined : idx;
}
