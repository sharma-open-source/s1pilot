import { newId, type LearnedScript, type ResolvedAction } from '@s1pilot/domain';
import { LearnedRecorder, type EngineAction } from '@s1pilot/engine';

import type { DraftAction } from './types.js';

/** A step as saved: final text (possibly edited in review), its inputs and the actions recorded for it. */
export interface RecordedStepInput {
  action: string;
  inputs: readonly string[];
  actions: readonly DraftAction[];
}

function toEngineAction(a: DraftAction): EngineAction | undefined {
  switch (a.kind) {
    case 'click':
    case 'check':
    case 'uncheck':
      return { kind: a.kind, locators: a.locators };
    case 'fill':
      return a.valueRef ? { kind: 'fill', valueRef: a.valueRef, locators: a.locators } : undefined;
    case 'selectOption':
      return a.valueRef ? { kind: 'selectOption', valueRef: a.valueRef, locators: a.locators } : undefined;
    case 'press':
      return { kind: 'press', key: a.key ?? 'Enter', locators: a.locators };
  }
}

/**
 * Learned actions for recorded steps. `stepIndex` is the step's position in `steps`; each action is
 * stamped with the hash of its step's final text, so editing a step later invalidates only that step.
 * Steps without actions (for example a step added in review) get a `wait` no-op.
 */
export function recordedToResolved(steps: readonly RecordedStepInput[], runId: string): ResolvedAction[] {
  const recorder = new LearnedRecorder(
    runId,
    steps.map((s) => ({ action: s.action, inputs: [...s.inputs] })),
  );
  steps.forEach((step, stepIndex) => {
    for (const a of step.actions) {
      const action = toEngineAction(a);
      if (!action) continue;
      recorder.record({
        stepIndex,
        action,
        preFingerprint: a.fingerprint,
        postFingerprint: a.postFingerprint,
        navigated: a.navigated,
      });
    }
  });
  return recorder.actions();
}

/**
 * Puts `inserted` (recorded steps, indices from 0) into an existing script at step `at`: actions of
 * existing steps at or after `at` shift by `count`. Returns the new action list.
 */
export function insertResolved(existing: readonly ResolvedAction[], inserted: readonly ResolvedAction[], at: number, count: number): ResolvedAction[] {
  const before = existing.filter((a) => a.stepIndex < at);
  const after = existing.filter((a) => a.stepIndex >= at).map((a) => ({ ...a, stepIndex: a.stepIndex + count }));
  return [...before, ...inserted.map((a) => ({ ...a, stepIndex: a.stepIndex + at })), ...after];
}

/** Builds a complete learned script value (not yet stored) for a case in one environment. */
export function recordedScript(input: {
  caseId: string;
  caseVersion: number;
  environmentId: string;
  actions: ResolvedAction[];
  runId?: string;
  now?: Date;
}): Omit<LearnedScript, 'health'> & { health?: LearnedScript['health'] } {
  return {
    id: newId(),
    caseId: input.caseId,
    caseVersion: input.caseVersion,
    environmentId: input.environmentId,
    actions: input.actions,
    createdFromRunId: input.runId ?? newId(),
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}
