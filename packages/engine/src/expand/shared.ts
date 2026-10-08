import { S1PilotError, type SharedStep, type Step, type TestCase } from '@s1pilot/domain';

/** Value bound to a `{name}` placeholder. */
export type ArgValue = string | number | boolean;

/** Finds a shared step / flow by id or name. */
export type FlowLookup = (idOrName: string) => SharedStep | undefined;

const PLACEHOLDER = /\{([\w.-]+)\}/g;
const MAX_DEPTH = 5;

/** Replaces `{name}` placeholders with `args[name]`; unknown placeholders are left as written. */
export function substitute(text: string, args: Readonly<Record<string, ArgValue>>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = args[name];
    return value === undefined ? whole : String(value);
  });
}

function bindStep(step: Step, args: Readonly<Record<string, ArgValue>>, flowName: string): Step {
  return {
    ...step,
    action: substitute(step.action, args),
    ...(step.expected !== undefined ? { expected: substitute(step.expected, args) } : {}),
    ...(step.args ? { args: Object.fromEntries(Object.entries(step.args).map(([k, v]) => [k, typeof v === 'string' ? substitute(v, args) : v])) } : {}),
    // A nested flow reference keeps its own id; leaf steps point at the flow they came from.
    sharedStepId: step.sharedStepId ?? flowName,
  };
}

function inline(steps: readonly Step[], lookup: FlowLookup, chain: readonly string[]): Step[] {
  const out: Step[] = [];
  for (const step of steps) {
    const ref = step.sharedStepId;
    // A step is a reference when it names a flow and has `args` or is a bare reference placeholder.
    if (ref === undefined || !isReference(step)) {
      const plain = { ...step };
      delete plain.args;
      out.push(plain);
      continue;
    }
    if (chain.length >= MAX_DEPTH) {
      throw new S1PilotError('FLOW_TOO_DEEP', `Shared steps nest deeper than ${MAX_DEPTH} levels at "${ref}"`, { flow: ref });
    }
    if (chain.includes(ref)) {
      throw new S1PilotError('FLOW_CYCLE', `Shared step "${ref}" includes itself (${[...chain, ref].join(' -> ')})`, { flow: ref });
    }
    const flow = lookup(ref);
    if (!flow) throw new S1PilotError('FLOW_NOT_FOUND', `Shared step / flow "${ref}" not found`, { flow: ref });
    const args = step.args ?? {};
    const missing = flow.params.filter((p) => args[p] === undefined);
    if (missing.length > 0) {
      throw new S1PilotError('FLOW_ARG_MISSING', `Flow "${flow.name}" needs argument(s): ${missing.join(', ')}`, { flow: flow.name, missing });
    }
    out.push(...inline(flow.steps.map((s) => bindStep(s, args, ref)), lookup, [...chain, ref]));
  }
  return out;
}

/** Marker action of reference steps created by the YAML loader / preconditions. */
export const FLOW_REF_PREFIX = 'Run flow ';

function isReference(step: Step): boolean {
  return step.action.startsWith(FLOW_REF_PREFIX) || step.args !== undefined;
}

/** Builds the reference step that {@link inlineSharedSteps} expands. */
export function flowReference(flow: string, args?: Record<string, ArgValue>): Step {
  return { action: `${FLOW_REF_PREFIX}${flow}`, assert: [], inputs: [], sharedStepId: flow, ...(args ? { args } : {}) };
}

/**
 * Inlines reference steps (`sharedStepId` + `args`, as produced by YAML `flow: name` steps) with
 * `{arg}` substitution. Every inlined step keeps `sharedStepId` so traces and heal can find the
 * shared step it came from. Nested flows are expanded; cycles and unknown flows throw.
 */
export function inlineSharedSteps(steps: readonly Step[], lookup: FlowLookup): Step[] {
  return inline(steps, lookup, []);
}

/** Steps to run before step 1: `flow:` preconditions inlined; `auth:` ones are returned separately. */
export function resolvePreconditions(testCase: Pick<TestCase, 'preconditions'>, lookup: FlowLookup): { steps: Step[]; auth: string[] } {
  const steps: Step[] = [];
  const auth: string[] = [];
  for (const pre of testCase.preconditions) {
    if ('flow' in pre) {
      steps.push(...inlineSharedSteps([flowReference(pre.flow)], lookup));
    } else {
      // Applied by the runner's auth provider (storage state), not by inlined steps.
      auth.push(pre.auth);
    }
  }
  return { steps, auth };
}
