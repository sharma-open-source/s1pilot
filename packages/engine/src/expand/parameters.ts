import { createHash } from 'node:crypto';

import { S1PilotError, type Step, type TestCase } from '@s1pilot/domain';

import { inlineSharedSteps, resolvePreconditions, substitute, type ArgValue, type FlowLookup } from './shared.js';

/** Rows of a test data set (CSV / JSON), keyed by column. */
export type DatasetRow = Record<string, ArgValue>;
/** Loads the rows of a named data set (resolved per environment by the caller). */
export type DatasetLookup = (name: string) => DatasetRow[] | undefined;

/** One executable instance of a case: a parameter row with shared steps inlined and text bound. */
export interface CaseInstance {
  /** The case with `parameters` consumed, shared steps inlined and `{param}` bound into step text. */
  testCase: TestCase;
  /** Parameter values as strings, for `param:` input refs. */
  params: Record<string, string>;
  /** Human label (row values joined with ` / `), e.g. `blue / M`; empty when the case has no parameters. */
  label: string;
  /** Zero-based row index. */
  index: number;
  /** Number of instances the case expanded into. */
  count: number;
  /** Steps of `flow:` preconditions, run before step 1; a failure makes the case `blocked`. */
  preconditionSteps: Step[];
  /**
   * Learned-script key. Instances whose bound steps are identical (parameters only reach the page
   * through `param:` input refs) share one key and therefore one script; differing actions get their own.
   */
  scriptKey: string;
}

/** Options for {@link expandCase}. */
export interface ExpandOptions {
  flows?: FlowLookup;
  datasets?: DatasetLookup;
}

const NO_FLOWS: FlowLookup = () => undefined;

function rowsOf(testCase: TestCase, datasets: DatasetLookup | undefined): DatasetRow[] {
  const rows: DatasetRow[] = [];
  for (const row of testCase.parameters) {
    const { dataset, ...extra } = row;
    if (typeof dataset !== 'string') {
      rows.push(row);
      continue;
    }
    const loaded = datasets?.(dataset);
    if (!loaded) throw new S1PilotError('DATASET_NOT_FOUND', `${testCase.key}: data set "${dataset}" not found`, { dataset });
    if (loaded.length === 0) throw new S1PilotError('DATASET_EMPTY', `${testCase.key}: data set "${dataset}" has no rows`, { dataset });
    for (const r of loaded) rows.push({ ...r, ...extra });
  }
  return rows;
}

function bindStep(step: Step, params: Record<string, string>): Step {
  return {
    ...step,
    action: substitute(step.action, params),
    ...(step.expected !== undefined ? { expected: substitute(step.expected, params) } : {}),
    // `inputs` keep their `param:` / `secret:` / `var:` refs; they are resolved at input time.
  };
}

/** Stable key of a bound step list; used to share learned scripts between identical instances. */
export function scriptKeyFor(caseKey: string, pre: readonly Step[], steps: readonly Step[]): string {
  const material = JSON.stringify([pre, steps].map((list) => list.map((s) => [s.action, s.expected ?? '', s.inputs, s.assert])));
  return `${caseKey}#${createHash('sha256').update(material).digest('hex').slice(0, 12)}`;
}

/**
 * Expands a case into one instance per parameter row (or a single instance without parameters).
 * Shared steps (`flow:` / `sharedStepId`) are inlined first, then `{param}` placeholders are bound
 * into step action / expected text for the model. A row `{ dataset: "addresses.csv" }` is replaced
 * by the rows of that data set. `flow:` preconditions are inlined into `preconditionSteps`.
 */
export function expandCase(testCase: TestCase, opts: ExpandOptions = {}): CaseInstance[] {
  const flows = opts.flows ?? NO_FLOWS;
  const inlined = inlineSharedSteps(testCase.steps, flows);
  const pre = resolvePreconditions(testCase, flows).steps;
  const rows = rowsOf(testCase, opts.datasets);
  const list: DatasetRow[] = rows.length > 0 ? rows : [{}];
  return list.map((row, index) => {
    const params = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)]));
    const steps = inlined.map((s) => bindStep(s, params));
    const preconditionSteps = pre.map((s) => bindStep(s, params));
    return {
      testCase: { ...testCase, steps, parameters: [] },
      params,
      label: Object.values(params).join(' / '),
      index,
      count: list.length,
      preconditionSteps,
      scriptKey: scriptKeyFor(testCase.key, preconditionSteps, steps),
    };
  });
}
