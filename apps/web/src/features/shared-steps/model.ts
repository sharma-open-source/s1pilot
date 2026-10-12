import type { Step } from '@s1pilot/domain';

import type { RouterOutputs } from '@/lib/trpc';

/** A shared step as listed by `sharedSteps.list`. */
export type SharedStepRow = RouterOutputs['sharedSteps']['list'][number];
/** Where a shared step is used. */
export type SharedStepUsage = SharedStepRow['usage'];

const PLACEHOLDER = /\{([A-Za-z_][\w-]*)\}/g;
/** Same rule as the server: names usable as `{param}`. */
const PARAM_NAME = /^[A-Za-z_][\w-]*$/;

/** `{name}` placeholders used in the steps' action and expected text, in first-seen order. */
export function placeholdersIn(steps: ReadonlyArray<Pick<Step, 'action' | 'expected' | 'args'>>): string[] {
  const out: string[] = [];
  for (const s of steps) {
    const texts = [s.action, s.expected ?? '', ...Object.values(s.args ?? {}).map(String)];
    for (const t of texts) for (const m of t.matchAll(PLACEHOLDER)) if (m[1] !== undefined && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Splits the comma-separated parameter field into names (trimmed, empty parts dropped). */
export function parseParams(text: string): string[] {
  return text
    .split(',')
    .map((p) => p.trim().replace(/^\{|\}$/g, ''))
    .filter((p) => p !== '');
}

/** Problems that block saving the parameter list, or `null`. */
export function paramsError(params: string[]): string | null {
  const bad = params.find((p) => !PARAM_NAME.test(p));
  if (bad !== undefined) return `"${bad}" is not a valid parameter name. Use letters, digits, "_" or "-", for example role.`;
  const dup = params.find((p, i) => params.indexOf(p) !== i);
  if (dup !== undefined) return `Parameter "${dup}" is listed twice.`;
  return null;
}

/** Hints about parameters: declared but unused, and `{x}` used without being declared. */
export function paramHints(params: string[], steps: ReadonlyArray<Pick<Step, 'action' | 'expected' | 'args'>>): string[] {
  const used = placeholdersIn(steps);
  const hints: string[] = [];
  const unused = params.filter((p) => !used.includes(p));
  if (unused.length > 0) hints.push(`Not used in any step: ${unused.map((p) => `{${p}}`).join(', ')}.`);
  const undeclared = used.filter((p) => !params.includes(p));
  if (undeclared.length > 0) {
    hints.push(
      `${undeclared.map((p) => `{${p}}`).join(', ')} ${undeclared.length === 1 ? 'is' : 'are'} not a parameter of this shared step, so every case that uses it must supply ${undeclared.length === 1 ? 'it' : 'them'} as test-data parameters. Add ${undeclared.length === 1 ? 'it' : 'them'} above to ask for a value instead.`,
    );
  }
  return hints;
}

/** Total number of places that run the shared step. */
export function usageTotal(u: SharedStepUsage): number {
  return u.steps.length + u.preconditions.length + u.flows.length + u.logins.length;
}

/** One line per kind of use, for dialogs and the editor aside. */
export function usageLines(u: SharedStepUsage): Array<{ label: string; items: string[] }> {
  return [
    { label: 'Steps in test cases', items: u.steps },
    { label: 'Preconditions of test cases', items: u.preconditions },
    { label: 'Other shared steps', items: u.flows },
    { label: 'Environment logins', items: u.logins },
  ].filter((l) => l.items.length > 0);
}
