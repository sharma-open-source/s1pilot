import { newId, type HealProposal, type LearnedScript, type ResolvedAction } from '@s1pilot/domain';

import { LearnedRecorder, hashStep, type ActionRecorder } from '../learned/recorder.js';
import { createLiteralStore } from '../text-input/index.js';

import { exploreStep } from './explore-step.js';
import { actionsForStep, replayStep, type ReplayBreak, type ReplayContext, type ReplayStepResult } from './replay-step.js';
import type { EngineContext, ExploreStepInput, StepExecution } from './types.js';

/** A heal proposal as the engine produces it; the repo stores it as `pending`. */
export type HealProposalDraft = Omit<HealProposal, 'status' | 'createdAt'>;

/** Meta choices of the explore loop that are not elements and so carry no locator. */
const META_CHOICES = new Set(['scroll_down', 'scroll_up', 'go_back', 'step_done', 'stuck']);

/** What {@link healStep} needs besides the engine context. */
export interface HealStepOptions {
  caseId: string;
  environmentId: string;
  /** The step to re-resolve (text, inputs, guards, shared step). */
  step: ExploreStepInput;
  /** The learned actions of the broken step (all of its sub-actions). */
  before: readonly ResolvedAction[];
  /** The break reported by {@link replayStep}. */
  brk: ReplayBreak;
}

/** Result of {@link healStep}. */
export interface HealResult {
  /** True when the step was re-resolved with enough confidence (`thresholds.act`) and performed. */
  healed: boolean;
  /** Why the heal was not accepted. */
  reason?: string;
  /** Outcome of the explore run for this step. */
  execution: StepExecution;
  /** Lowest System 1 probability behind a chosen element; 0 when nothing was chosen. */
  confidence: number;
  /** Set when `healed`; the caller stores it with `repos.healProposals.create`. */
  proposal?: HealProposalDraft;
}

/** Records into a collector and forwards to the context's own recorder, if any. */
function tee(first: ActionRecorder, second: ActionRecorder | undefined): ActionRecorder {
  return { record: (entry) => { first.record(entry); second?.record(entry); } };
}

/**
 * Re-resolves one broken step with System 1 (plan section 2.3, Heal). Runs {@link exploreStep} for
 * that step only, starting from the current page state (the actions of the step that replayed
 * before the break have already happened). The step's new action list is the unchanged prefix of
 * `before` (sub-actions before the break) followed by the freshly resolved actions.
 *
 * Policy: when the step is performed and the lowest chosen-element probability is at least
 * `thresholds.act`, the step counts as healed and a `pending` {@link HealProposalDraft} is
 * returned; the learned script is not changed here. Otherwise `healed` is false and nothing is
 * proposed. Never throws for model, page or action failures.
 */
export async function healStep(ctx: EngineContext, opts: HealStepOptions): Promise<HealResult> {
  const { step, before, brk } = opts;
  const collector = new LearnedRecorder(ctx.runId);
  const outer = ctx.recorder;
  ctx.recorder = tee(collector, outer);
  let execution: StepExecution;
  try {
    execution = await exploreStep(ctx, step);
  } finally {
    if (outer) ctx.recorder = outer;
    else delete ctx.recorder;
  }

  const probabilities = execution.decisions
    .filter((d) => d.questionId === 'next_action' && d.chosen !== undefined && !META_CHOICES.has(d.chosen))
    .map((d) => d.probabilities[d.chosen as string] ?? d.confidence);
  const confidence = probabilities.length > 0 ? Math.min(...probabilities) : 0;

  const fail = (reason: string): HealResult => ({ healed: false, reason, execution, confidence });
  if (execution.status !== 'passed') return fail(execution.reason ?? `step ${execution.status}`);
  const fresh = collector.actions().filter((a) => a.stepIndex === step.index);
  if (fresh.length === 0) return fail('System 1 found nothing to do for the step');
  if (confidence < ctx.thresholds.act) {
    return fail(`confidence ${confidence.toFixed(2)} is below the act threshold ${ctx.thresholds.act}`);
  }

  const stepHash = before.find((a) => a.stepHash)?.stepHash ?? hashStep(step);
  const prefix = [...before].filter((a) => a.subIndex < brk.subIndex).sort((a, b) => a.subIndex - b.subIndex);
  const after: ResolvedAction[] = [
    ...prefix,
    ...fresh.map((a, i) => ({ ...a, stepIndex: step.index, subIndex: prefix.length + i, stepHash })),
  ];
  const escalated = execution.decisions.some((d) => d.escalatedTo === 'system2');
  return {
    healed: true,
    execution,
    confidence,
    proposal: {
      id: newId(),
      caseId: opts.caseId,
      stepIndex: step.index,
      environmentId: opts.environmentId,
      runId: ctx.runId,
      before: [...before].sort((a, b) => a.subIndex - b.subIndex),
      after,
      confidence,
      ...(escalated ? { s2Agreed: true } : {}),
      ...(step.sharedStepId ? { sharedStepId: step.sharedStepId } : {}),
      impactCaseIds: [opts.caseId],
    },
  };
}

/** Outcome of one step of {@link replayWithHeal}. */
export interface HealedStepResult {
  stepIndex: number;
  /** `replay` when the learned actions worked, `healed` when System 1 re-resolved the step. */
  mode: 'replay' | 'healed';
  status: 'passed' | 'failed' | 'blocked';
  replay: ReplayStepResult;
  /** Present when a heal was attempted. */
  heal?: HealResult;
}

/** What {@link replayWithHeal} needs about the case. */
export interface ReplayWithHealInput {
  caseId: string;
  environmentId: string;
  /** Steps bound for this instance; `index` must match the script's `stepIndex`. */
  steps: readonly ExploreStepInput[];
  script: LearnedScript;
  /** `replay-only` never heals: a break fails the step. Default `replay-heal`. */
  mode?: 'replay-heal' | 'replay-only';
}

/** Result of {@link replayWithHeal}. */
export interface ReplayWithHealResult {
  status: 'passed' | 'failed' | 'blocked';
  steps: HealedStepResult[];
  /** One draft per healed step, in step order. */
  proposals: HealProposalDraft[];
}

/**
 * Replays a case from its learned script and heals broken steps (plan section 2.3). Each step is
 * replayed; on a {@link ReplayBreak} (unless `mode` is `replay-only`) {@link healStep} re-resolves
 * only that step, and replay continues with the next step on the page state the heal left behind.
 * A step that cannot be healed ends the run. Verifying each step's expectation stays with the
 * caller. `ctx.page` and the replay page are kept in sync.
 */
export async function replayWithHeal(ctx: EngineContext, input: ReplayWithHealInput): Promise<ReplayWithHealResult> {
  const replayCtx: ReplayContext = {
    page: ctx.page,
    vars: ctx.vars,
    params: ctx.params,
    redactor: ctx.redactor,
    literals: (ctx.literals ??= createLiteralStore()),
    ...(ctx.executor ? { executor: ctx.executor } : {}),
  };
  const steps: HealedStepResult[] = [];
  const proposals: HealProposalDraft[] = [];
  const finish = (status: ReplayWithHealResult['status']): ReplayWithHealResult => ({ status, steps, proposals });

  for (const step of input.steps) {
    const before = actionsForStep(input.script, step.index);
    replayCtx.page = ctx.page;
    const replay: ReplayStepResult =
      before.length > 0
        ? await replayStep(replayCtx, step.index, before)
        : {
            stepIndex: step.index,
            mode: 'replay',
            status: 'failed',
            actions: [],
            break: { stepIndex: step.index, subIndex: 0, reason: 'action-error', message: 'No learned actions for this step' },
            durationMs: 0,
          };
    ctx.page = replayCtx.page;
    if (replay.status === 'passed') {
      steps.push({ stepIndex: step.index, mode: 'replay', status: 'passed', replay });
      continue;
    }
    if (input.mode === 'replay-only' || !replay.break) {
      steps.push({ stepIndex: step.index, mode: 'replay', status: 'failed', replay });
      return finish('failed');
    }

    const heal = await healStep(ctx, { caseId: input.caseId, environmentId: input.environmentId, step, before, brk: replay.break });
    if (!heal.healed || !heal.proposal) {
      const status = heal.execution.status === 'blocked' ? 'blocked' : 'failed';
      steps.push({ stepIndex: step.index, mode: 'healed', status, replay, heal });
      return finish(status);
    }
    proposals.push(heal.proposal);
    steps.push({ stepIndex: step.index, mode: 'healed', status: 'passed', replay, heal });
  }
  return finish('passed');
}
