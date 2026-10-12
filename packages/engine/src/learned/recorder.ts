import { createHash } from 'node:crypto';

import {
  ActionKindSchema,
  LearnedScriptSchema,
  newId,
  type LearnedScript,
  type LocatorCandidate,
  type ResolvedAction,
  type Verdict,
} from '@s1pilot/domain';

import type { EngineAction } from '../executor/types.js';

/** One successfully executed action, as reported by the explore loop. */
export interface RecordedAction {
  stepIndex: number;
  action: EngineAction;
  /** Locator that performed the action; moved to the front of the candidates. */
  usedLocator?: LocatorCandidate;
  preFingerprint: string;
  postFingerprint: string;
  navigated: boolean;
}

/** Receives executed actions from `exploreStep` (set as `EngineContext.recorder`). */
export interface ActionRecorder {
  record(entry: RecordedAction): void;
}

/** A step as far as hashing is concerned. */
export interface HashableStep {
  action: string;
  inputs?: readonly string[];
}

/** Stable hash of a step's text (and test-data inputs) used for invalidation. */
export function hashStep(step: HashableStep): string {
  return createHash('sha256')
    .update(JSON.stringify([step.action.trim(), [...(step.inputs ?? [])].sort()]))
    .digest('hex')
    .slice(0, 16);
}

function sameLocator(a: LocatorCandidate, b: LocatorCandidate): boolean {
  return a.kind === b.kind && a.value === b.value && a.name === b.name;
}

/** Collects {@link ResolvedAction}s while a case is explored. */
export class LearnedRecorder implements ActionRecorder {
  private readonly out: ResolvedAction[] = [];
  private readonly subIndex = new Map<number, number>();

  /**
   * @param runId run the actions come from
   * @param steps the case's steps, used to stamp each action with its step hash
   */
  constructor(
    private readonly runId: string,
    private readonly steps: readonly HashableStep[] = [],
  ) {}

  /** Records one executed action (unreplayable kinds such as `upload` are skipped). */
  record(entry: RecordedAction): void {
    const { action } = entry;
    const kind = ActionKindSchema.safeParse(action.kind);
    if (!kind.success) return;
    const raw = 'locators' in action && action.locators ? [...action.locators] : [];
    const first = entry.usedLocator ?? raw[0];
    const locators = first ? [first, ...raw.filter((l) => !sameLocator(l, first))] : raw;
    const sub = this.subIndex.get(entry.stepIndex) ?? 0;
    this.subIndex.set(entry.stepIndex, sub + 1);
    const valueRef = 'valueRef' in action ? action.valueRef : action.kind === 'upload' ? action.fileRef : undefined;
    const key = action.kind === 'press' ? action.key : undefined;
    const targetLocators = action.kind === 'drag' ? [...action.target.locators] : undefined;
    const step = this.steps[entry.stepIndex];
    this.out.push({
      stepIndex: entry.stepIndex,
      subIndex: sub,
      action: kind.data,
      locators,
      ...(targetLocators ? { targetLocators } : {}),
      ...(key ? { key } : {}),
      ...(valueRef ? { valueRef } : {}),
      fingerprint: entry.preFingerprint,
      postFingerprint: entry.postFingerprint,
      waitHint: entry.navigated ? 'navigation' : 'none',
      ...(step ? { stepHash: hashStep(step) } : {}),
      fromRunId: this.runId,
    });
  }

  /**
   * Actions recorded so far, in execution order. A step that finished without acting (for example
   * "Stop before payment", judged done at once) gets a single `wait` no-op so every step of the
   * case is represented and can be invalidated on its own.
   */
  actions(): ResolvedAction[] {
    const out: ResolvedAction[] = [];
    let carry = 'start';
    for (const [stepIndex, step] of this.steps.entries()) {
      const own = this.out.filter((a) => a.stepIndex === stepIndex);
      if (own.length === 0) {
        out.push({
          stepIndex,
          subIndex: 0,
          action: 'wait',
          locators: [],
          fingerprint: carry,
          postFingerprint: carry,
          waitHint: 'none',
          stepHash: hashStep(step),
          fromRunId: this.runId,
        });
      } else {
        carry = own[own.length - 1]?.postFingerprint ?? carry;
        out.push(...own);
      }
    }
    // Actions for steps beyond the declared list (no step info): keep them as recorded.
    out.push(...this.out.filter((a) => a.stepIndex >= this.steps.length));
    return out;
  }
}

/** Input of {@link buildLearnedScript}. */
export interface BuildLearnedScriptInput {
  caseId: string;
  caseVersion: number;
  environmentId: string;
  runId: string;
  /** Case verdict of the explore run. */
  verdict: Verdict;
  /** True when a human approved a non-passing run. */
  humanApproved?: boolean;
  recorder: LearnedRecorder;
  now?: Date;
}

/**
 * Turns an explore run into a learned script. Returns `null` unless the case passed (or a human
 * approved it) and at least one action was recorded.
 */
export function buildLearnedScript(input: BuildLearnedScriptInput): LearnedScript | null {
  if (input.verdict !== 'passed' && input.humanApproved !== true) return null;
  const actions = input.recorder.actions();
  if (actions.length === 0) return null;
  return LearnedScriptSchema.parse({
    id: newId(),
    caseId: input.caseId,
    caseVersion: input.caseVersion,
    environmentId: input.environmentId,
    actions,
    createdFromRunId: input.runId,
    createdAt: (input.now ?? new Date()).toISOString(),
  });
}

/** Indices of steps whose learned actions no longer match the case's step text. */
export function staleSteps(script: LearnedScript, steps: readonly HashableStep[]): number[] {
  const stale = new Set<number>();
  for (const a of script.actions) {
    const step = steps[a.stepIndex];
    if (!step || a.stepHash === undefined || a.stepHash !== hashStep(step)) stale.add(a.stepIndex);
  }
  return [...stale].sort((x, y) => x - y);
}

/**
 * Drops the actions of changed (or removed) steps and keeps the rest; the script moves to
 * `caseVersion`. Invalidated steps must be re-explored before the script is complete again.
 */
export function invalidateChangedSteps(
  script: LearnedScript,
  steps: readonly HashableStep[],
  caseVersion: number = script.caseVersion,
): { script: LearnedScript; invalidated: number[] } {
  const invalidated = staleSteps(script, steps);
  const drop = new Set(invalidated);
  return {
    script: { ...script, caseVersion, actions: script.actions.filter((a) => !drop.has(a.stepIndex)) },
    invalidated,
  };
}
