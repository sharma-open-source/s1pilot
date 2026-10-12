import type { ExecutionMode, LearnedScript, Redactor, ResolvedAction } from '@s1pilot/domain';
import type { Page } from 'playwright';

import { execute } from '../executor/index.js';
import type { EngineAction, ExecutorContext } from '../executor/types.js';
import type { StableWaitOptions } from '../executor/waits.js';
import { staleSteps, type HashableStep } from '../learned/recorder.js';
import { fingerprintsMatch, observer, pageFingerprint } from '../observer/observation.js';
import { createLiteralStore, createValueResolver, type LiteralStore, type VarLookup } from '../text-input/index.js';

/** Why a replay stopped. Healing the step is up to S-025. */
export type ReplayBreakReason = 'fingerprint' | 'locator' | 'action-error';

/** Where and why a learned step could not be replayed. */
export interface ReplayBreak {
  stepIndex: number;
  subIndex: number;
  reason: ReplayBreakReason;
  /** Redacted detail for logs and the heal flow. */
  message?: string;
}

/** What {@link replayStep} needs. No model is involved: replay is deterministic. */
export interface ReplayContext {
  /** Current page; replaced when an action opens a popup / new tab. */
  page: Page;
  /** Variables for `var:` / `secret:` value refs. */
  vars: VarLookup;
  /** Parameters of the current row for `param:` value refs. */
  params: Record<string, string>;
  redactor: Redactor;
  literals?: LiteralStore;
  /** Unredacted, parameter-bound text of the step being replayed, for `quote:` value refs. */
  stepText?: string;
  /** Extra executor options. Replay settles faster than explore unless `stable` is given. */
  executor?: Omit<ExecutorContext, 'resolveValue'>;
}

/** An action performed (or attempted) by the replayer. */
export interface ReplayedAction {
  subIndex: number;
  kind: string;
  valueRef?: string;
  ok: boolean;
  error?: string;
}

/** Result of {@link replayStep}. `mode` is always `replay` (recorded per step in `StepResult`). */
export interface ReplayStepResult {
  stepIndex: number;
  mode: 'replay';
  status: 'passed' | 'failed';
  actions: ReplayedAction[];
  /** Set when `status` is `failed`. */
  break?: ReplayBreak;
  durationMs: number;
}

/** Quiet-period settings used after each replayed action (explore waits longer). */
export const REPLAY_STABLE: StableWaitOptions = { networkIdleMs: 20, quietMs: 50, quietCapMs: 1000 };

/** How long replay keeps re-checking a fingerprint or locator that has not appeared yet. */
const SETTLE_BUDGET_MS = 2000;
const SETTLE_POLL_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Actions of one step in `subIndex` order. */
export function actionsForStep(script: LearnedScript, stepIndex: number): ResolvedAction[] {
  return script.actions.filter((a) => a.stepIndex === stepIndex).sort((a, b) => a.subIndex - b.subIndex);
}

/** Maps a learned action onto an executor action, or explains why it cannot be replayed. */
function toEngineAction(a: ResolvedAction): EngineAction | { unreplayable: string } {
  // Structural CSS paths are only a last resort: when a semantic candidate (role+name, test id,
  // text) was learned, the CSS path would let a renamed or replaced control pass silently. Dropping
  // it makes such changes surface as a `locator` break (for the heal flow, S-025).
  const semantic = a.locators.filter((l) => l.kind !== 'css');
  const locators = semantic.length > 0 ? semantic : a.locators;
  switch (a.action) {
    case 'click':
    case 'dblclick':
    case 'rightclick':
    case 'hover':
    case 'check':
    case 'uncheck':
      return { kind: a.action, locators };
    case 'drag': {
      const drop = (a.targetLocators ?? []).filter((l) => l.kind !== 'css');
      return a.targetLocators && a.targetLocators.length > 0
        ? { kind: 'drag', locators, target: { locators: drop.length > 0 ? drop : a.targetLocators } }
        : { unreplayable: 'drag without a drop target' };
    }
    case 'upload':
      return a.valueRef ? { kind: 'upload', fileRef: a.valueRef, locators } : { unreplayable: 'upload without a file reference' };
    case 'press':
      // Without a key (scripts learned before keys were recorded) there is nothing to replay.
      return a.key ? { kind: 'press', key: a.key, ...(a.locators.length > 0 ? { locators } : {}) } : { unreplayable: 'press without a recorded key' };
    case 'fill':
      return a.valueRef
        ? { kind: 'fill', valueRef: a.valueRef, locators }
        : { unreplayable: 'fill without a value reference' };
    case 'selectOption':
      return a.valueRef
        ? { kind: 'selectOption', valueRef: a.valueRef, locators }
        : { unreplayable: 'selectOption without a value reference' };
    case 'goBack':
      return { kind: 'goBack' };
    case 'scroll':
      // Targeted scrolls only (page scrolls are skipped by the caller): page text scrolled into view.
      return { kind: 'scroll', dir: 'into-view', locators };
    default:
      // goto: the learned script keeps no URL.
      return { unreplayable: `${a.action} cannot be replayed from the learned script` };
  }
}

/**
 * Replays the learned actions of one step without calling any model (plan section 2.3).
 *
 * For each action, in `subIndex` order: compare the page fingerprint with the recorded one
 * (tolerant: same URL pattern and at least 80% landmark/heading overlap), try the locator
 * candidates in order through the executor, perform the action, then honour the wait hint. The
 * first problem ends the step with a {@link ReplayBreak}: `fingerprint` (page differs),
 * `locator` (no candidate resolves to one element) or `action-error` (anything else). Never
 * throws. Verification of the step's expectation stays with the caller (`verifyStep`), which only
 * consults a model for AI-judged assertions.
 */
export async function replayStep(
  ctx: ReplayContext,
  stepIndex: number,
  actions: readonly ResolvedAction[],
): Promise<ReplayStepResult> {
  const started = performance.now();
  const done: ReplayedAction[] = [];
  const literals = (ctx.literals ??= createLiteralStore());
  const resolveValue = createValueResolver({
    vars: ctx.vars,
    params: ctx.params,
    literals,
    ...(ctx.stepText !== undefined ? { stepText: ctx.stepText } : {}),
  });
  const r = (s: string): string => ctx.redactor.redact(s);
  const ordered = [...actions].sort((a, b) => a.subIndex - b.subIndex);

  const fail = (a: ResolvedAction, reason: ReplayBreakReason, message: string): ReplayStepResult => {
    done.push({
      subIndex: a.subIndex,
      kind: a.action,
      ...(a.valueRef ? { valueRef: a.valueRef } : {}),
      ok: false,
      error: r(message),
    });
    return {
      stepIndex,
      mode: 'replay',
      status: 'failed',
      actions: done,
      break: { stepIndex, subIndex: a.subIndex, reason, message: r(message) },
      durationMs: performance.now() - started,
    };
  };

  for (const a of ordered) {
    // A step that acted on nothing in the explore run (`wait` with no target) and page scrolls are no-ops;
    // a scroll with a target (page text scrolled into view) is replayed.
    if ((a.action === 'wait' || a.action === 'scroll') && a.locators.length === 0) {
      done.push({ subIndex: a.subIndex, kind: a.action, ok: true });
      continue;
    }

    // The page may still be settling (replay waits less than explore): re-check for a short while
    // before declaring a mismatch.
    let matched = false;
    const deadline = performance.now() + SETTLE_BUDGET_MS;
    for (;;) {
      try {
        matched = fingerprintsMatch(a.fingerprint, pageFingerprint(await observer.capture(ctx.page, { texts: false })));
      } catch (error) {
        if (performance.now() >= deadline) {
          return fail(a, 'action-error', `Could not observe the page: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (matched || performance.now() >= deadline) break;
      await sleep(SETTLE_POLL_MS);
    }
    if (!matched) return fail(a, 'fingerprint', 'The page no longer matches the one this action was learned on');

    const action = toEngineAction(a);
    if ('unreplayable' in action) return fail(a, 'action-error', action.unreplayable);

    let outcome = await execute(ctx.page, action, { stable: REPLAY_STABLE, ...ctx.executor, resolveValue });
    const locatorDeadline = performance.now() + SETTLE_BUDGET_MS;
    while (!outcome.ok && outcome.error?.code === 'locator_not_found' && performance.now() < locatorDeadline) {
      await sleep(SETTLE_POLL_MS);
      outcome = await execute(ctx.page, action, { stable: REPLAY_STABLE, ...ctx.executor, resolveValue });
    }
    if (outcome.newPage) ctx.page = outcome.newPage.page;
    if (!outcome.ok) {
      const code = outcome.error?.code;
      return fail(a, code === 'locator_not_found' ? 'locator' : 'action-error', outcome.error?.message ?? 'Action failed');
    }
    if (a.waitHint === 'navigation' && !outcome.navigated) {
      await ctx.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    }
    done.push({ subIndex: a.subIndex, kind: a.action, ...(a.valueRef ? { valueRef: a.valueRef } : {}), ok: true });
  }

  return { stepIndex, mode: 'replay', status: 'passed', actions: done, durationMs: performance.now() - started };
}

/** Why {@link chooseMode} picked its mode. */
export type ModeReason =
  | 'plan-explore'
  | 'no-script'
  | 'environment-mismatch'
  | 'stale-steps'
  | 'incomplete-script'
  | 'script-ok';

/** Outcome of {@link chooseMode}. */
export interface ModeChoice {
  mode: ExecutionMode;
  reason: ModeReason;
  /** Step indices whose learned actions no longer match the step text. */
  staleSteps: number[];
  /**
   * True when the plan demands `replay-only` but no usable script exists: the caller must not
   * fall back to the model and should report the case as blocked.
   */
  blocked: boolean;
}

/**
 * Picks how a case runs. `planMode` `explore` always explores. Otherwise replay needs a learned
 * script for this environment whose actions cover every step and whose step hashes still match
 * `testCase.steps` (pass the steps bound for the instance, as the recorder hashed them, and look
 * the script up by the instance's `scriptKey`). With such a script the result is the plan's mode
 * (`replay-only` or `replay-heal`); otherwise `explore`, with `blocked` set for `replay-only`.
 * Healing a partly stale script is S-025.
 */
export function chooseMode(
  testCase: { steps: readonly HashableStep[] },
  env: { id: string },
  planMode: ExecutionMode = 'replay-heal',
  script?: LearnedScript | null,
): ModeChoice {
  const explore = (reason: ModeReason, stale: number[] = []): ModeChoice => ({
    mode: 'explore',
    reason,
    staleSteps: stale,
    blocked: planMode === 'replay-only' && reason !== 'plan-explore',
  });
  if (planMode === 'explore') return explore('plan-explore');
  if (!script || script.actions.length === 0) return explore('no-script');
  if (script.environmentId !== env.id) return explore('environment-mismatch');
  const stale = staleSteps(script, testCase.steps);
  if (stale.length > 0) return explore('stale-steps', stale);
  const covered = new Set(script.actions.map((a) => a.stepIndex));
  if (testCase.steps.some((_, i) => !covered.has(i))) return explore('incomplete-script');
  return { mode: planMode, reason: 'script-ok', staleSteps: [], blocked: false };
}
