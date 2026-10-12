import { S1PilotError, type DecideAnswer, type DecisionRecord, type Thresholds } from '@s1pilot/domain';
import type { ChatModel } from '@s1pilot/providers';

import { HUMAN_UNAVAILABLE, type HumanDecider, type HumanHook, type HumanResponse } from './human.js';

/** Meta options that always mean "the model cannot proceed". */
export const META_OPTIONS: readonly string[] = ['stuck', 'blocked'];

/** A sensitive action (pay, delete, send, prod env) about to be taken. */
export interface SensitiveAction {
  /** Action class, e.g. `pay`, `delete`, `send`, `prod`. Classification itself is S-018. */
  actionClass: string;
  /** True when the environment explicitly allows this action class without approval. */
  allowed?: boolean;
}

export interface GateOptions {
  thresholds: Thresholds;
  /** Id of the question being decided (stored on the record). */
  questionId: string;
  /** The question's instructions, shown to System 2 and the human. */
  question: string;
  /** Option id → description; the gate only ever returns one of these ids. */
  options: Record<string, string>;
  /** Name of the System 1 model (stored on the record). */
  model: string;
  /** Latency of the System 1 call in ms (stored on the record). Default 0. */
  latencyMs?: number;
  /** Untrusted page context for System 2; passed as data only. */
  context?: string;
  /** Optional System 2 second opinion for the middle band. */
  s2?: ChatModel;
  /** Human escalation hook. Never called when `attended` is false. */
  human?: HumanHook;
  /** Whether a human is available. Unattended runs never await a human. */
  attended: boolean;
  /** Present when the pending action is sensitive. */
  sensitive?: SensitiveAction | undefined;
  /** Set when dual-order judging disagreed: treated as below the act threshold. */
  disagreement?: boolean;
  /** Base64 screenshot forwarded to the human. */
  screenshot?: string;
}

interface Base {
  /** Human-readable explanation of how this outcome was reached. */
  reason: string;
  /** Always present; `escalatedTo` names the last escalation actually consulted. */
  record: DecisionRecord;
}

/** Outcome of {@link gate}. Every variant carries a {@link DecisionRecord}. */
export type GateResult =
  | (Base & { outcome: 'act'; choice: string })
  | (Base & { outcome: 'blocked' })
  | (Base & { outcome: 'skip' })
  | (Base & { outcome: 'abort' })
  | (Base & { outcome: 'takeover'; resume?: boolean });

type Band = 'act' | 'middle' | 'low';

/**
 * Turns a System 1 answer into an action decision (plan section 7):
 * - confidence >= act (and no disagreement, not sensitive) -> act;
 * - escalate <= confidence < act (or disagreement) -> System 2 `pickOption`; agree -> act, else human/blocked;
 * - confidence < escalate, no choice, or `stuck`/`blocked` -> human (attended) or blocked;
 * - sensitive action not allowed by the environment -> always human (attended) or blocked.
 * Unattended runs never call the human hook.
 */
export async function gate(answer: DecideAnswer, opts: GateOptions): Promise<GateResult> {
  const { thresholds, options } = opts;
  const choice = answer.choice;
  const known = choice !== undefined && Object.hasOwn(options, choice);
  const meta = choice !== undefined && META_OPTIONS.includes(choice);
  const sensitive = opts.sensitive !== undefined && opts.sensitive.allowed !== true;

  const record = (
    chosen: string | undefined,
    escalatedTo?: DecisionRecord['escalatedTo'],
    decider?: HumanDecider,
  ): DecisionRecord => ({
    questionId: opts.questionId,
    options: Object.keys(options),
    optionLabels: { ...options },
    probabilities: answer.probabilities,
    ...(chosen === undefined ? {} : { chosen }),
    confidence: answer.confidence,
    ...(answer.raw ? { raw: answer.raw } : {}),
    model: opts.model,
    latencyMs: opts.latencyMs ?? 0,
    ...(escalatedTo === undefined ? {} : { escalatedTo }),
    ...(decider?.decidedBy === undefined ? {} : { decidedBy: decider.decidedBy }),
    ...(decider?.via === undefined ? {} : { via: decider.via }),
  });

  const band: Band =
    !known || meta || answer.confidence < thresholds.escalate
      ? 'low'
      : answer.confidence >= thresholds.act && opts.disagreement !== true
        ? 'act'
        : 'middle';

  const blocked = (reason: string, s2Tried: boolean): GateResult => ({
    outcome: 'blocked',
    reason,
    record: record(undefined, s2Tried ? 'system2' : undefined),
  });

  const askHuman = async (reason: string, s2Tried: boolean, s2Choice?: string): Promise<GateResult> => {
    if (!opts.attended) return blocked(`${reason}; unattended run, not asking a human`, s2Tried);
    if (opts.human === undefined) return blocked(`${reason}; no human hook configured`, s2Tried);
    let response: HumanResponse;
    try {
      response = await opts.human.ask({
        question: opts.question,
        options,
        probabilities: answer.probabilities,
        ...(opts.screenshot === undefined ? {} : { screenshot: opts.screenshot }),
        reason,
        confidence: answer.confidence,
        thresholds: { act: thresholds.act, escalate: thresholds.escalate },
        ...(s2Choice === undefined ? {} : { s2Choice }),
      });
    } catch (error) {
      if (error instanceof S1PilotError && error.code === HUMAN_UNAVAILABLE) {
        return blocked(`${reason}; human unavailable`, s2Tried);
      }
      throw error;
    }
    if ('choice' in response) {
      if (!Object.hasOwn(options, response.choice)) {
        throw new S1PilotError('HUMAN_INVALID_CHOICE', `Human chose unknown option "${response.choice}"`, {
          options: Object.keys(options),
        });
      }
      return {
        outcome: 'act',
        choice: response.choice,
        reason: `${reason}; human chose ${response.choice}`,
        record: record(response.choice, 'human', response),
      };
    }
    const outcome = 'skip' in response ? 'skip' : 'abort' in response ? 'abort' : 'takeover';
    const result = { outcome, reason: `${reason}; human responded: ${outcome}`, record: record(undefined, 'human', response) } as const;
    return 'takeover' in response && response.resume === true ? { ...result, outcome: 'takeover', resume: true } : result;
  };

  if (sensitive) {
    return askHuman(`sensitive action (${opts.sensitive?.actionClass ?? 'unknown'}) requires approval`, false);
  }
  if (band === 'act') {
    return {
      outcome: 'act',
      choice: choice as string,
      reason: `confidence ${answer.confidence.toFixed(2)} >= act ${thresholds.act}`,
      record: record(choice),
    };
  }
  if (band === 'low') {
    const why = !known
      ? 'model gave no valid choice'
      : meta
        ? `model chose "${choice}"`
        : `confidence ${answer.confidence.toFixed(2)} < escalate ${thresholds.escalate}`;
    return askHuman(why, false);
  }

  // Middle band: confidence in [escalate, act), or dual-order disagreement.
  const why =
    opts.disagreement === true
      ? 'dual-order judging disagreed'
      : `confidence ${answer.confidence.toFixed(2)} between escalate ${thresholds.escalate} and act ${thresholds.act}`;
  if (opts.s2 === undefined) return askHuman(`${why}; no System 2 configured`, false);
  let second: string;
  try {
    second = (await opts.s2.pickOption({ context: opts.context ?? '', question: opts.question, options })).choice;
  } catch (error) {
    return askHuman(`${why}; System 2 failed (${error instanceof Error ? error.message : 'unknown error'})`, true);
  }
  if (second === choice) {
    return {
      outcome: 'act',
      choice: second,
      reason: `${why}; System 2 agreed on ${second}`,
      record: record(second, 'system2'),
    };
  }
  return askHuman(`${why}; System 2 chose ${second} but System 1 chose ${choice}`, true, second);
}
