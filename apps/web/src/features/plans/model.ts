import type { ExecutionMode, ExitCriterion, MatrixEntry, PlanChecks } from '@s1pilot/domain';

/** Environment fields the plan builder needs. */
export interface PlanEnv {
  id: string;
  name: string;
  readOnly: boolean;
  browsers: Array<{ browser: MatrixEntry['browser']; device?: string | undefined }>;
}

export type MatrixBrowser = 'chromium' | 'firefox' | 'webkit' | 'mobile';
export const MATRIX_COLUMNS: Array<{ id: MatrixBrowser; label: string }> = [
  { id: 'chromium', label: 'Chromium' },
  { id: 'firefox', label: 'Firefox' },
  { id: 'webkit', label: 'WebKit' },
  { id: 'mobile', label: 'Mobile' },
];

/** Emulated devices offered in the Mobile column; each runs on its natural engine. */
export const MOBILE_DEVICES: Array<{ name: string; browser: MatrixEntry['browser'] }> = [
  { name: 'Pixel 7', browser: 'chromium' },
  { name: 'iPhone 13', browser: 'webkit' },
];

export const MODE_OPTIONS: Array<{ value: ExecutionMode; label: string }> = [
  { value: 'replay-heal', label: 'Replay first, heal with S1' },
  { value: 'explore', label: 'Explore everything with S1' },
  { value: 'replay-only', label: 'Replay only (no AI)' },
];

export const UNATTENDED_OPTIONS = [
  { value: 'block', label: 'Mark blocked & continue' },
  { value: 'pause', label: 'Pause and notify' },
] as const;

/** Editable plan state (what the form shows; `toDraft` turns it into a `plans.create` body). */
export interface PlanForm {
  name: string;
  release: string;
  selectionKind: 'query' | 'list';
  query: string;
  caseIds: string[];
  matrix: MatrixEntry[];
  mobileDevice: string;
  mode: ExecutionMode;
  retries: number;
  parallelism: number;
  /** Comma-separated worker labels the plan requires (empty = any worker). */
  workerLabels: string;
  unattended: 'block' | 'pause';
  scheduleOn: boolean;
  cron: string;
  exitCriteria: ExitCriterion[];
  checks: PlanChecks;
}

/** Stored plan as returned by `plans.get` (the fields the form reads). */
export interface StoredPlan {
  id: string;
  name: string;
  release?: string | undefined;
  selection: { kind: 'query'; query: string } | { kind: 'list'; caseIds: string[] };
  matrix: MatrixEntry[];
  retries: number;
  parallelism: number;
  workerLabels?: string[] | undefined;
  mode: ExecutionMode;
  unattended: 'block' | 'pause';
  schedule?: string | undefined;
  exitCriteria: ExitCriterion[];
  checks: PlanChecks;
}

export const DEFAULT_CRON = '0 2 * * 1-5';

/** Blank plan: first writable environment on Chromium. */
export function blankForm(envs: PlanEnv[], caseIds: string[] = []): PlanForm {
  const first = envs.find((e) => !e.readOnly) ?? envs[0];
  return {
    name: '',
    release: '',
    selectionKind: caseIds.length > 0 ? 'list' : 'query',
    query: '',
    caseIds,
    matrix: first !== undefined ? [{ environmentId: first.id, browser: 'chromium' }] : [],
    mobileDevice: MOBILE_DEVICES[0]?.name ?? 'Pixel 7',
    mode: 'replay-heal',
    retries: 1,
    parallelism: 4,
    workerLabels: '',
    unattended: 'block',
    scheduleOn: false,
    cron: DEFAULT_CRON,
    exitCriteria: [],
    checks: { a11y: false, consoleErrors: true, visual: false, video: false },
  };
}

/** Form state for a stored plan. */
export function formFromPlan(plan: StoredPlan): PlanForm {
  const device = plan.matrix.find((m) => m.device !== undefined)?.device;
  return {
    name: plan.name,
    release: plan.release ?? '',
    selectionKind: plan.selection.kind,
    query: plan.selection.kind === 'query' ? plan.selection.query : '',
    caseIds: plan.selection.kind === 'list' ? plan.selection.caseIds : [],
    matrix: plan.matrix,
    mobileDevice: device ?? MOBILE_DEVICES[0]?.name ?? 'Pixel 7',
    mode: plan.mode,
    retries: plan.retries,
    parallelism: plan.parallelism,
    workerLabels: (plan.workerLabels ?? []).join(', '),
    unattended: plan.unattended,
    scheduleOn: plan.schedule !== undefined && plan.schedule !== '',
    cron: plan.schedule !== undefined && plan.schedule !== '' ? plan.schedule : DEFAULT_CRON,
    exitCriteria: plan.exitCriteria,
    checks: plan.checks,
  };
}

/** Body of `plans.create` (without `projectKey`) / `plans.update` patch. */
export function toDraft(f: PlanForm) {
  const schedule = f.scheduleOn && f.cron.trim() !== '' ? { schedule: f.cron.trim() } : {};
  const release = f.release.trim() !== '' ? { release: f.release.trim() } : {};
  return {
    name: f.name.trim(),
    ...release,
    selection: f.selectionKind === 'query' ? { kind: 'query' as const, query: f.query.trim() } : { kind: 'list' as const, caseIds: f.caseIds },
    matrix: f.matrix,
    retries: f.retries,
    parallelism: f.parallelism,
    workerLabels: f.workerLabels.split(',').map((l) => l.trim()).filter((l) => l !== ''),
    mode: f.mode,
    unattended: f.unattended,
    exitCriteria: f.exitCriteria,
    checks: f.checks,
    ...schedule,
  };
}

/** True when the environment accepts a browser/device (read-only environments only accept their listed ones). */
export function entryAllowed(env: PlanEnv, entry: MatrixEntry): boolean {
  if (!env.readOnly) return true;
  return env.browsers.some((b) => b.browser === entry.browser && (b.device ?? undefined) === (entry.device ?? undefined));
}

/** Matrix entry a column stands for. */
export function columnEntry(envId: string, col: MatrixBrowser, device: string): MatrixEntry {
  if (col !== 'mobile') return { environmentId: envId, browser: col };
  const d = MOBILE_DEVICES.find((m) => m.name === device);
  return { environmentId: envId, browser: d?.browser ?? 'chromium', device };
}

const same = (a: MatrixEntry, b: MatrixEntry) => a.environmentId === b.environmentId && a.browser === b.browser && (a.device ?? '') === (b.device ?? '');

/** Whether the cell of (environment, column) is ticked. */
export function cellChecked(matrix: MatrixEntry[], envId: string, col: MatrixBrowser, device: string): boolean {
  const e = columnEntry(envId, col, device);
  return matrix.some((m) => same(m, e));
}

/** Matrix after toggling one cell. */
export function toggleCell(matrix: MatrixEntry[], envId: string, col: MatrixBrowser, device: string): MatrixEntry[] {
  const e = columnEntry(envId, col, device);
  return matrix.some((m) => same(m, e)) ? matrix.filter((m) => !same(m, e)) : [...matrix, e];
}

/** Matrix with every mobile entry re-pointed at another device. */
export function changeDevice(matrix: MatrixEntry[], device: string): MatrixEntry[] {
  return matrix.map((m) => (m.device !== undefined ? columnEntry(m.environmentId, 'mobile', device) : m));
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function describeDays(field: string): string | undefined {
  if (field === '*') return 'every day';
  const names: string[] = [];
  for (const part of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range !== null) {
      names.push(`${DAYS[Number(range[1]) % 7]}–${DAYS[Number(range[2]) % 7]}`);
    } else if (/^\d$/.test(part)) names.push(DAYS[Number(part) % 7] ?? part);
    else return undefined;
  }
  return names.join(', ');
}

/** Validates a 5-field cron expression and describes it (`At 02:00, Mon–Fri`). */
export function describeCron(expr: string): { valid: boolean; text: string } {
  const fields = expr.trim().split(/\s+/);
  if (expr.trim() === '' || fields.length !== 5 || !fields.every((f) => /^[\d*,/-]+$/.test(f))) {
    return { valid: false, text: 'Enter 5 cron fields: minute hour day-of-month month day-of-week' };
  }
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  if (/^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hour) && Number(min) < 60 && Number(hour) < 24 && dom === '*' && mon === '*') {
    const days = describeDays(dow);
    if (days !== undefined) return { valid: true, text: `At ${hour.padStart(2, '0')}:${min.padStart(2, '0')}, ${days}` };
  }
  return { valid: true, text: 'Custom schedule' };
}

/** Exit criterion templates (evaluated by `@s1pilot/domain` evaluateCriteria). */
export const CRITERION_TEMPLATES: Array<{ kind: string; label: string; params: Record<string, unknown> }> = [
  { kind: 'p0-passed', label: '% of P0 cases passed', params: { percent: 100 } },
  { kind: 'pass-rate', label: '≥ n% of P1–P2 passed', params: { percent: 95, priorities: ['P1', 'P2'] } },
  { kind: 'no-open-defects', label: 'No open defects ≥ severity', params: { severity: 'S2' } },
  { kind: 'review-queue-empty', label: 'Review queue empty', params: {} },
  { kind: 'no-flaky', label: 'No flaky cases', params: { priorities: ['P0', 'P1', 'P2', 'P3'] } },
  { kind: 'all-executed', label: 'All cases executed', params: {} },
];

export const SEVERITIES = ['S1', 'S2', 'S3', 'S4'] as const;

/** Plain-text summary of a criterion. */
export function criterionText(c: ExitCriterion): string {
  const p = c.params;
  const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
  switch (c.kind) {
    case 'p0-passed':
      return `${num('percent', 100)}% of P0 cases passed`;
    case 'pass-rate':
      return `≥ ${num('percent', 95)}% of P1–P2 passed`;
    case 'no-open-defects':
      return `No open defects ≥ ${typeof p['severity'] === 'string' ? p['severity'] : 'S2'}`;
    case 'review-queue-empty':
      return 'Review queue empty';
    case 'no-flaky':
      return 'No flaky cases';
    case 'all-executed':
      return 'All cases executed';
    default:
      return c.kind;
  }
}

export interface FormProblems {
  name?: string;
  query?: string;
  matrix?: string;
  cron?: string;
}

/** Problems that block saving; empty when the form is valid. */
export function validateForm(f: PlanForm): FormProblems {
  const out: FormProblems = {};
  if (f.name.trim() === '') out.name = 'Give the plan a name';
  if (f.selectionKind === 'query' && f.query.trim() === '') out.query = 'Enter a query';
  if (f.matrix.length === 0) out.matrix = 'Tick at least one environment and browser';
  if (f.scheduleOn && !describeCron(f.cron).valid) out.cron = 'Invalid cron expression';
  return out;
}

/** Matrix label for the list: `3 combos · staging, dev`. */
export function matrixSummary(matrix: MatrixEntry[], envs: PlanEnv[]): string {
  const names = [...new Set(matrix.map((m) => envs.find((e) => e.id === m.environmentId)?.name ?? '?'))];
  return `${matrix.length} combo${matrix.length === 1 ? '' : 's'} · ${names.join(', ')}`;
}
