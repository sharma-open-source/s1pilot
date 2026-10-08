import type { Capabilities, DecisionModel, DecisionRecord, Environment, Redactor, RunEvent, Thresholds } from '@s1pilot/domain';
import type { ChatModel } from '@s1pilot/providers';
import type { Page } from 'playwright';

import type { HumanHook } from '../decide/human.js';
import type { ExecutorContext } from '../executor/types.js';
import type { LoopGuard, LoopLimits } from '../guards/loop.js';
import type { ActionRecorder } from '../learned/recorder.js';
import type { ActionHistory } from '../observer/history.js';
import type { InputVars, LiteralStore, VarLookup } from '../text-input/index.js';
import type { StepEnd, TraceWriter } from '../trace/index.js';

/**
 * Everything the explore loop needs. One context per case: `page`, `history`, `guard` and
 * `literals` are updated/created lazily by {@link exploreStep}.
 */
export interface EngineContext {
  /** Current page; replaced when an action opens a popup / new tab. */
  page: Page;
  /** System 1 decision model. */
  s1: DecisionModel;
  /** Optional System 2 for the middle confidence band and free-text input. */
  s2?: ChatModel;
  /** Optional human escalation. Only consulted when `attended` is true. */
  human?: HumanHook;
  /** Environment variables (secrets by reference only). */
  vars: InputVars & VarLookup;
  /** Test-case parameters for the current row. */
  params: Record<string, string>;
  environment: Pick<Environment, 'requireApprovalFor'>;
  thresholds: Thresholds;
  /** System 1 capabilities (`maxOptions` bounds every choice question). */
  caps: Capabilities;
  /** Redactor seeded with the secret values; applied to everything sent to models, events and traces. */
  redactor: Redactor;
  /** Receives run events (step.started, decision.made, ..., step.finished). */
  emit: (event: RunEvent) => void;
  trace: TraceWriter;
  /** Loop budgets; used to create `guard` on first use. */
  budgets: LoopLimits;
  runId: string;
  caseResultId: string;
  /** Name stored on decision records. Default `system1`. */
  modelName?: string;
  /** Whether a human can be asked. Default: true when `human` is set. */
  attended?: boolean;
  /** Extra executor options (dialog policy, download dir, action timeout). */
  executor?: Omit<ExecutorContext, 'resolveValue'>;
  history?: ActionHistory;
  guard?: LoopGuard;
  literals?: LiteralStore;
  /** Optional learned-script recorder (S-023); receives every successfully executed action. */
  recorder?: ActionRecorder;
}

/** One natural-language step handed to {@link exploreStep}. */
export interface ExploreStepInput {
  /** Zero-based index within the case. */
  index: number;
  /** Step text; `{name}` placeholders are bound from `ctx.params`. */
  action: string;
  /** Test-data keys the step may use for text input. */
  inputs?: string[];
  /** Step `guard` rules such as `block submit_payment`. */
  guards?: string[];
  /** Shared step / flow this step was inlined from; recorded in the trace for heal impact. */
  sharedStepId?: string;
}

/** An action the loop took (no resolved values, only refs). */
export interface ExecutedAction {
  kind: string;
  elementId?: string;
  target?: string;
  valueRef?: string;
  ok: boolean;
  error?: string;
}

/**
 * Result of {@link exploreStep}. `passed` means the step's action was performed (or the model judged
 * it done); the expected result is verified separately (S-020/S-021).
 */
export interface StepExecution {
  stepIndex: number;
  status: 'passed' | 'failed' | 'blocked' | 'skipped';
  ended: StepEnd;
  reason?: string;
  /** Description of the last action taken. */
  actionTaken?: string;
  actions: ExecutedAction[];
  decisions: DecisionRecord[];
  iterations: number;
  durationMs: number;
}
