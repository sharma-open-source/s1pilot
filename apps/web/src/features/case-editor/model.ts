import type { Assertion, Parameters, Precondition, Priority, Step, TestCaseStatus, TestCaseType } from '@s1pilot/domain';
import { summarizeAssertion } from '@s1pilot/domain/assertion-summary';

export { summarizeAssertion };

/** A step as edited in the grid; `uid` is a client-only row key and is stripped before saving. */
export interface DraftStep extends Step {
  uid: string;
}

/** Editable content of a case (everything `cases.update` accepts in `patch`, minus the suite). */
export interface Draft {
  title: string;
  priority: Priority;
  type: TestCaseType;
  status: TestCaseStatus;
  tags: string[];
  requirements: string[];
  preconditions: Precondition[];
  parameters: Parameters;
  steps: DraftStep[];
}

/** Server shape of a case, limited to the fields the editor reads. */
export interface CaseContent {
  title: string;
  priority: Priority;
  type: TestCaseType;
  status: TestCaseStatus;
  tags: string[];
  requirements: string[];
  preconditions: Precondition[];
  parameters: Parameters;
  steps: Step[];
}

let counter = 0;
/** Fresh client-only row id. */
export function newUid(): string {
  counter += 1;
  return `row-${counter}`;
}

/** Builds an editable draft from a stored case. */
export function toDraft(c: CaseContent): Draft {
  return {
    title: c.title,
    priority: c.priority,
    type: c.type,
    status: c.status,
    tags: [...c.tags],
    requirements: [...c.requirements],
    preconditions: c.preconditions.map((p) => ({ ...p })),
    parameters: c.parameters.map((r) => ({ ...r })),
    steps: c.steps.map((s) => ({ ...s, assert: [...s.assert], inputs: [...s.inputs], uid: newUid() })),
  };
}

/** Drops client-only fields and empty optional values; this is the `patch` sent to `cases.update`. */
export function toPatch(d: Draft): CaseContent {
  return {
    title: d.title.trim(),
    priority: d.priority,
    type: d.type,
    status: d.status,
    tags: d.tags,
    requirements: d.requirements,
    preconditions: d.preconditions,
    parameters: d.parameters,
    steps: d.steps.map(({ uid, ...s }) => {
      void uid;
      const expected = s.expected?.trim();
      return {
        action: s.action,
        ...(expected ? { expected } : {}),
        assert: s.assert,
        inputs: s.inputs,
        ...(s.sharedStepId !== undefined ? { sharedStepId: s.sharedStepId } : {}),
        ...(s.args !== undefined ? { args: s.args } : {}),
      };
    }),
  };
}

/** True when the draft differs from the stored content. */
export function isDirty(base: CaseContent, draft: Draft): boolean {
  return JSON.stringify(toPatch(draft)) !== JSON.stringify(toPatch(toDraft(base)));
}

/** Blank step appended by "+ Add step". */
export function blankStep(): DraftStep {
  return { uid: newUid(), action: '', assert: [], inputs: [] };
}

/** Moves the step at `from` to index `to` (clamped). */
export function moveStep<T>(steps: T[], from: number, to: number): T[] {
  const target = Math.max(0, Math.min(steps.length - 1, to));
  if (from === target || from < 0 || from >= steps.length) return steps;
  const next = [...steps];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item as T);
  return next;
}

/** Copies the step at `index` right below it with a new row id. */
export function duplicateStep(steps: DraftStep[], index: number): DraftStep[] {
  const src = steps[index];
  if (!src) return steps;
  const copy: DraftStep = { ...src, assert: [...src.assert], inputs: [...src.inputs], uid: newUid() };
  return [...steps.slice(0, index + 1), copy, ...steps.slice(index + 1)];
}

/** Removes the step at `index`. */
export function removeStep(steps: DraftStep[], index: number): DraftStep[] {
  return steps.filter((_, i) => i !== index);
}

const PARAM_RE = /\{([A-Za-z_][\w-]*)\}/g;

/** Splits text into plain and `{param}` parts (rendered as chips). */
export function splitParams(text: string): Array<{ kind: 'text' | 'param'; value: string }> {
  const out: Array<{ kind: 'text' | 'param'; value: string }> = [];
  let last = 0;
  for (const m of text.matchAll(PARAM_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', value: text.slice(last, at) });
    out.push({ kind: 'param', value: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}

/** Parameter names (columns) used by the data rows, in first-seen order. */
export function paramNames(rows: Parameters): string[] {
  const names: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!names.includes(k)) names.push(k);
  return names;
}

/** Autocomplete trigger at the caret: `{par` (parameters) or `@fl` (shared steps). */
export function completionAt(text: string, caret: number): { kind: 'param' | 'shared'; query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const param = /\{([\w-]*)$/.exec(before);
  if (param) return { kind: 'param', query: param[1] ?? '', start: before.length - param[0].length };
  const shared = /(?:^|\s)@([\w -]*)$/.exec(before);
  if (shared) {
    const q = shared[1] ?? '';
    return { kind: 'shared', query: q, start: before.length - q.length - 1 };
  }
  return undefined;
}

/** Tag descriptors for the Checks column. */
export interface CheckTag {
  kind: 'ai' | 'assertion';
  label: string;
  /** Index into `step.assert` (assertions only). */
  assertIndex?: number;
}

/**
 * Checks of a step: an `AI check` tag by default when expected text is present (or an explicit `ai`
 * assertion exists), then one tag per deterministic assertion using `summarizeAssertion`.
 */
export function checkTags(step: Pick<Step, 'expected' | 'assert'>): CheckTag[] {
  const tags: CheckTag[] = [];
  const hasAi = step.assert.some((a) => a.type === 'ai');
  if (hasAi || (step.expected?.trim() ?? '') !== '') tags.push({ kind: 'ai', label: 'AI check' });
  step.assert.forEach((a, i) => {
    if (a.type !== 'ai') tags.push({ kind: 'assertion', label: summarizeAssertion(a), assertIndex: i });
  });
  return tags;
}

/** Field kinds of the assertion builder. */
export interface FieldDef {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'select' | 'checkbox';
  options?: readonly string[];
  required?: boolean;
  hint?: string;
}

const TARGET: FieldDef[] = [
  { name: 'role', label: 'Role', kind: 'text', hint: 'e.g. button' },
  { name: 'name', label: 'Accessible name', kind: 'text' },
  { name: 'text', label: 'Text', kind: 'text' },
  { name: 'testId', label: 'Test id', kind: 'text' },
  { name: 'css', label: 'CSS selector', kind: 'text' },
];

/** Assertion types selectable in the builder, with their label and input fields (S-021 types). */
export const ASSERTION_TYPES: ReadonlyArray<{ type: Assertion['type']; label: string; fields: FieldDef[] }> = [
  { type: 'urlMatches', label: 'URL matches', fields: [{ name: 'pattern', label: 'URL pattern', kind: 'text', required: true, hint: 'Glob (/checkout/*) or regex' }] },
  { type: 'titleContains', label: 'Title contains', fields: [{ name: 'contains', label: 'Text', kind: 'text', required: true }] },
  { type: 'elementVisible', label: 'Element visible', fields: [...TARGET, { name: 'visible', label: 'Expect', kind: 'select', options: ['visible', 'hidden'] }] },
  {
    type: 'elementText',
    label: 'Element text',
    fields: [...TARGET, { name: 'contains', label: 'Contains', kind: 'text' }, { name: 'equals', label: 'Equals', kind: 'text' }],
  },
  { type: 'elementValue', label: 'Element value', fields: [...TARGET, { name: 'equals', label: 'Equals', kind: 'text', required: true }] },
  {
    type: 'elementCount',
    label: 'Element count',
    fields: [
      ...TARGET,
      { name: 'equals', label: 'Exactly', kind: 'number' },
      { name: 'min', label: 'At least', kind: 'number' },
      { name: 'max', label: 'At most', kind: 'number' },
    ],
  },
  {
    type: 'responseStatus',
    label: 'Response status',
    fields: [
      { name: 'urlPattern', label: 'URL pattern', kind: 'text', required: true },
      { name: 'status', label: 'Status', kind: 'number', required: true },
      { name: 'method', label: 'Method', kind: 'text' },
    ],
  },
  { type: 'noConsoleErrors', label: 'No console errors', fields: [{ name: 'allow', label: 'Allowed messages', kind: 'text', hint: 'Comma-separated' }] },
  { type: 'downloadExists', label: 'Download exists', fields: [{ name: 'filenamePattern', label: 'Filename pattern', kind: 'text' }] },
  {
    type: 'apiCheck',
    label: 'API check',
    fields: [
      { name: 'method', label: 'Method', kind: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { name: 'url', label: 'URL', kind: 'text', required: true },
      { name: 'status', label: 'Status', kind: 'number' },
      { name: 'bodyContains', label: 'Body contains', kind: 'text' },
    ],
  },
  {
    type: 'ai',
    label: 'AI check',
    fields: [
      { name: 'expected', label: 'Expectation', kind: 'text', required: true },
      { name: 'critical', label: 'Critical (judged in dual order)', kind: 'checkbox' },
    ],
  },
];

export type AssertionValues = Record<string, string | boolean | undefined>;

export type BuildResult = { ok: true; assertion: Assertion } | { ok: false; error: string };

const TARGET_TYPES = new Set<Assertion['type']>(['elementVisible', 'elementText', 'elementValue', 'elementCount']);

/** Builds an `Assertion` from builder input; returns a message when a required field is missing or invalid. */
export function buildAssertion(type: Assertion['type'], values: AssertionValues): BuildResult {
  const def = ASSERTION_TYPES.find((t) => t.type === type);
  if (!def) return { ok: false, error: `Unknown assertion type ${type}` };
  const out: Record<string, unknown> = { type };
  for (const f of def.fields) {
    const raw = values[f.name];
    if (f.kind === 'checkbox') {
      out[f.name] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') {
      if (f.required === true) return { ok: false, error: `${f.label} is required` };
      continue;
    }
    if (f.kind === 'number') {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 0) return { ok: false, error: `${f.label} must be a whole number` };
      if (f.name === 'status' && (n < 100 || n > 599)) return { ok: false, error: 'Status must be between 100 and 599' };
      out[f.name] = n;
    } else if (type === 'elementVisible' && f.name === 'visible') {
      out['visible'] = text === 'visible';
    } else if (type === 'noConsoleErrors' && f.name === 'allow') {
      out['allow'] = text.split(',').map((x) => x.trim()).filter(Boolean);
    } else {
      out[f.name] = text;
    }
  }
  if (type === 'elementVisible' && out['visible'] === undefined) out['visible'] = true;
  if (type === 'noConsoleErrors' && out['allow'] === undefined) out['allow'] = [];
  if (type === 'apiCheck' && out['method'] === undefined) out['method'] = 'GET';
  if (TARGET_TYPES.has(type) && !['role', 'name', 'text', 'testId', 'css'].some((k) => typeof out[k] === 'string')) {
    return { ok: false, error: 'Set at least one of role, text, test id or CSS selector' };
  }
  if (type === 'elementText' && out['contains'] === undefined && out['equals'] === undefined) {
    return { ok: false, error: 'Set "Contains" or "Equals"' };
  }
  if (type === 'elementCount' && out['equals'] === undefined && out['min'] === undefined && out['max'] === undefined) {
    return { ok: false, error: 'Set Exactly, At least or At most' };
  }
  if (type === 'ai' && out['critical'] === undefined) out['critical'] = false;
  return { ok: true, assertion: out as unknown as Assertion };
}

/** One line per step (`1. action -> expected`), used for the conflict comparison. */
export function stepLines(steps: Array<Pick<Step, 'action' | 'expected' | 'assert' | 'inputs'>>): string[] {
  return steps.flatMap((s, i) => {
    const head = `${i + 1}. ${s.action}${s.expected ? ` -> ${s.expected}` : ''}`;
    const extra = [...s.assert.map((a) => `   check: ${summarizeAssertion(a)}`), ...(s.inputs.length > 0 ? [`   inputs: ${s.inputs.join(', ')}`] : [])];
    return [head, ...extra];
  });
}

export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

/** Line diff (LCS) between two line lists. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const at = (i: number, j: number): number => lcs[i]?.[j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i];
    if (!row) continue;
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] ?? '' });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push({ kind: 'remove', text: a[i++] ?? '' });
    } else {
      out.push({ kind: 'add', text: b[j++] ?? '' });
    }
  }
  while (i < n) out.push({ kind: 'remove', text: a[i++] ?? '' });
  while (j < m) out.push({ kind: 'add', text: b[j++] ?? '' });
  return out;
}

/** Precondition as a tag label (`flow: clear-cart`, `auth: none (guest)`). */
export function preconditionLabel(p: Precondition): string {
  return 'flow' in p ? `flow: ${p.flow}` : `auth: ${p.auth}`;
}

/** Parses `flow: name` / `auth: name` tag text; returns `undefined` when it is neither. */
export function parsePrecondition(text: string): Precondition | undefined {
  const m = /^(flow|auth)\s*:\s*(.+)$/i.exec(text.trim());
  if (!m) return undefined;
  const value = (m[2] ?? '').trim();
  return (m[1] ?? '').toLowerCase() === 'flow' ? { flow: value } : { auth: value };
}
