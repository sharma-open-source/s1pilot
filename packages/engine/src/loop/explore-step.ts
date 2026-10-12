import {
  newId,
  type DecideAnswer,
  type DecisionRecord,
  type EscalationTarget,
  type Question,
  type RunEvent,
} from '@s1pilot/domain';

import { gate, type GateResult } from '../decide/gate.js';
import type { HumanHook } from '../decide/human.js';
import { execute } from '../executor/index.js';
import { inferAction } from '../executor/infer.js';
import type { ActionOutcome, EngineAction } from '../executor/types.js';
import { actionKey, LoopGuard } from '../guards/loop.js';
import { checkSensitive, type SensitiveCheck } from '../guards/sensitive.js';
import { wrapUntrusted } from '../guards/untrusted.js';
import { matchingTexts } from '../narrow/lexical.js';
import { narrow } from '../narrow/narrow.js';
import { ActionHistory } from '../observer/history.js';
import { observer, pageFingerprint, serializeObservation, type Observation } from '../observer/observation.js';
import { isTextBlock, type ObservedElement } from '../observer/types.js';
import { createLiteralStore, createValueResolver, resolveInput } from '../text-input/index.js';
import { TraceLineSchema, type StepEnd, type TraceLine } from '../trace/schema.js';

import type { EngineContext, ExecutedAction, ExploreStepInput, StepExecution } from './types.js';

/** Meta options offered next to the candidate elements (plan section 6). */
const META_DESCRIPTIONS: Record<string, string> = {
  scroll_down: 'Scroll the page down',
  scroll_up: 'Scroll the page up',
  go_back: 'Go back to the previous page',
  step_done: 'The step is already fully performed',
  stuck: 'None of the options can make progress on this step',
};

/** Upper bound of elements sent in one `observation.elements` event. */
const MAX_OVERLAY_ELEMENTS = 300;
const STEP_DONE_QUESTION = "Has this test step's action been fully performed?";
const BLOCKED_QUESTION = 'Is progress blocked (error, login wall, captcha)?';

/**
 * What choosing an element does. Text blocks are clicked when they look clickable (pointer cursor,
 * typically a script click handler) and otherwise scrolled into view; controls follow {@link inferAction}.
 */
function actionKindOf(element: ObservedElement): ReturnType<typeof inferAction> | 'scroll' {
  if (isTextBlock(element)) return element.clickable ? 'click' : 'scroll';
  return inferAction(element, true);
}

/** Option label for the `next_action` question. */
function describeOption(element: ObservedElement): string {
  const label = `[${element.role}] ${element.name || element.text || element.placeholder || ''}`.trim();
  if (!isTextBlock(element)) return label;
  return `${label} (${element.clickable ? 'click it' : 'scroll it into view'})`;
}

type EventBody = RunEvent extends infer E ? (E extends { type: string } ? Omit<E, 'runId' | 'ts'> : never) : never;
type IterationLine = Extract<TraceLine, { kind: 'iteration' }>;

/** Replaces `{name}` placeholders with parameter values; unknown placeholders stay as written. */
function bindParams(text: string, params: Record<string, string>): string {
  return text.replace(/\{([\w.-]+)\}/g, (whole, name: string) => params[name] ?? whole);
}

function noulRecord(id: string, answer: DecideAnswer | undefined, model: string, latencyMs: number): DecisionRecord {
  const p = answer?.noul ?? 0;
  const probabilities =
    answer && Object.keys(answer.probabilities).length > 0 ? answer.probabilities : { true: p, false: 1 - p };
  return {
    questionId: id,
    options: ['true', 'false'],
    probabilities,
    chosen: p >= 0.5 ? 'true' : 'false',
    confidence: answer?.confidence ?? 0,
    ...(answer?.raw ? { raw: answer.raw } : {}),
    model,
    latencyMs,
  };
}

function choiceRecord(id: string, options: string[], answer: DecideAnswer | undefined, model: string, latencyMs: number): DecisionRecord {
  return {
    questionId: id,
    options,
    probabilities: answer?.probabilities ?? {},
    ...(answer?.choice === undefined ? {} : { chosen: answer.choice }),
    confidence: answer?.confidence ?? 0,
    ...(answer?.raw ? { raw: answer.raw } : {}),
    model,
    latencyMs,
  };
}

/**
 * Executes one natural-language test step in Explore mode (plan sections 2.3 and 6).
 *
 * Each iteration: observe the page, narrow the candidates, ask System 1 the `next_action`,
 * `step_done` and `blocked` questions in one call, then either finish (step done / blocked), or
 * gate the chosen action (sensitivity + step guards first), resolve any text input, check the loop
 * guard and execute. Ends when the step is done, blocked, a guard stops it, or a budget runs out.
 * Emits `step.started`, `decision.made`..., `step.finished` through `ctx.emit` and writes
 * redacted, schema-validated lines to `ctx.trace`. Never throws for model, page or action failures;
 * those end the step as `failed`/`blocked`.
 */
export async function exploreStep(ctx: EngineContext, step: ExploreStepInput): Promise<StepExecution> {
  const started = performance.now();
  const modelName = ctx.modelName ?? 'system1';
  const stepIndex = step.index;
  const r = (s: string): string => ctx.redactor.redact(s);
  const text = bindParams(step.action, ctx.params);
  const safeText = r(text);

  const guard = (ctx.guard ??= new LoopGuard(ctx.budgets));
  const history = (ctx.history ??= new ActionHistory());
  const literals = (ctx.literals ??= createLiteralStore());
  const resolveValue = createValueResolver({ vars: ctx.vars, params: ctx.params, literals });
  guard.beginCaseStep();

  const attended = ctx.attended ?? ctx.human !== undefined;
  const decisions: DecisionRecord[] = [];
  const actions: ExecutedAction[] = [];
  let iterations = 0;

  const emit = (body: EventBody): void => {
    ctx.emit({ ...body, runId: ctx.runId, ts: new Date().toISOString() } as RunEvent);
  };
  const writeTrace = async (line: Record<string, unknown>): Promise<void> => {
    const parsed = TraceLineSchema.parse({
      v: 1,
      ts: new Date().toISOString(),
      runId: ctx.runId,
      caseResultId: ctx.caseResultId,
      stepIndex,
      ...line,
    });
    await ctx.trace.write(parsed);
  };
  const decided = (record: DecisionRecord): void => {
    decisions.push(record);
    emit({ type: 'decision.made', caseResultId: ctx.caseResultId, stepIndex, decision: record });
  };

  /** Wraps the human hook so escalations surface as events at the moment they happen. */
  const humanHook = (sensitive: boolean): HumanHook | undefined => {
    const inner = ctx.human;
    if (!inner) return undefined;
    return {
      async ask(req) {
        const escalationId = req.escalationId ?? newId();
        const reason = sensitive
          ? 'sensitive-action'
          : /"stuck"/.test(req.reason)
            ? 'stuck'
            : /"blocked"/.test(req.reason)
              ? 'blocked'
              : 'low-confidence';
        const to: EscalationTarget = 'human';
        emit({
          type: 'escalation.needed',
          caseResultId: ctx.caseResultId,
          stepIndex,
          escalationId,
          reason,
          to,
          options: Object.keys(req.options),
          question: r(req.question),
          detail: r(req.reason),
          probabilities: req.probabilities,
          optionLabels: Object.fromEntries(Object.entries(req.options).map(([id, label]) => [id, r(label)])),
          ...(req.s2Choice === undefined ? {} : { s2Choice: req.s2Choice }),
          ...(req.thresholds ? { thresholds: req.thresholds } : {}),
        });
        const response = await inner.ask({ ...req, escalationId });
        emit({
          type: 'escalation.resolved',
          escalationId,
          by: to,
          resolution:
            'choice' in response
              ? (response.resolution ?? 'picked-other')
              : 'skip' in response
                ? 'skipped'
                : 'abort' in response
                  ? 'aborted'
                  : 'taken-over',
          ...('choice' in response ? { chosen: response.choice } : {}),
        });
        return response;
      },
    };
  };

  emit({ type: 'step.started', caseResultId: ctx.caseResultId, stepIndex, action: safeText });
  await writeTrace({
    kind: 'step.started',
    text: safeText,
    inputs: step.inputs ?? [],
    ...(step.sharedStepId ? { sharedStepId: step.sharedStepId } : {}),
  });

  const finish = async (
    status: StepExecution['status'],
    ended: StepEnd,
    reason?: string,
  ): Promise<StepExecution> => {
    const durationMs = Math.round(performance.now() - started);
    const safeReason = reason === undefined ? undefined : r(reason);
    if (safeReason !== undefined && ended !== 'step_done') {
      emit({ type: 'log', level: status === 'failed' ? 'error' : 'warn', message: `Step ${stepIndex} ${ended}: ${safeReason}` });
    }
    emit({
      type: 'step.finished',
      caseResultId: ctx.caseResultId,
      stepIndex,
      status,
      durationMs,
    });
    await writeTrace({
      kind: 'step.finished',
      status,
      ended,
      ...(safeReason === undefined ? {} : { reason: safeReason }),
      actions: actions.length,
      durationMs,
    });
    const last = actions[actions.length - 1];
    return {
      stepIndex,
      status,
      ended,
      ...(safeReason === undefined ? {} : { reason: safeReason }),
      ...(last ? { actionTaken: [last.kind, last.target].filter(Boolean).join(' ') } : {}),
      actions,
      decisions,
      iterations,
      durationMs,
    };
  };

  for (;;) {
    iterations += 1;
    const iterationDecisions: DecisionRecord[] = [];
    const record = (d: DecisionRecord): void => {
      iterationDecisions.push(d);
      decided(d);
    };
    const timings = { observe: 0, narrow: 0, decide: 0, gate: 0, execute: 0 };
    const lap = (key: keyof typeof timings, since: number): void => {
      timings[key] = Math.round(performance.now() - since);
    };

    // 1. Observe.
    let t = performance.now();
    let obs: Observation;
    try {
      obs = await observer.capture(ctx.page, { history });
    } catch (error) {
      return finish('failed', 'error', `Could not observe the page: ${error instanceof Error ? error.message : String(error)}`);
    }
    lap('observe', t);
    const fingerprint = pageFingerprint(obs);
    const summary: IterationLine['observation'] = {
      url: r(obs.context.url),
      title: r(obs.context.title),
      headings: obs.context.headings.map(r),
      alerts: obs.context.alerts.map(r),
      dialogs: obs.context.dialogs.map(r),
      elementCount: obs.elements.length,
      fingerprint,
    };
    const iterationLine = (extra: Record<string, unknown>, questions: IterationLine['questions']): Promise<void> =>
      writeTrace({
        kind: 'iteration',
        iteration: iterations,
        observation: summary,
        questions,
        decisions: iterationDecisions,
        timingsMs: timings,
        ...extra,
      });

    // 2. Narrow and 3. decide.
    let candidates: ObservedElement[];
    let answers: Record<string, DecideAnswer>;
    const optionDescriptions: Record<string, string> = {};
    let decideMs = 0;
    try {
      t = performance.now();
      // Page text matching the step joins the controls, so "scroll to Reviews" has something to point at.
      const pool = [...obs.elements, ...matchingTexts(obs.texts ?? [], safeText)];
      const narrowed = await narrow({ elements: pool }, ctx.caps, ctx.s1, safeText, { modelName });
      lap('narrow', t);
      narrowed.trail.forEach(record);
      candidates = narrowed.candidates;
      for (const e of candidates) optionDescriptions[e.id] = r(describeOption(e));
      Object.assign(optionDescriptions, META_DESCRIPTIONS);

      const shown: Observation = { ...obs, elements: candidates };
      const state = {
        step: safeText,
        page: wrapUntrusted(serializeObservation(shown, { redactor: ctx.redactor }), { label: 'observation', maxLength: 12000 }),
      };
      const questions: Record<string, Question> = {
        next_action: {
          type: 'choice',
          instructions: `Which single action moves this test step forward: ${safeText}`,
          criteria: optionDescriptions,
        },
        step_done: { type: 'noul', instructions: STEP_DONE_QUESTION },
        blocked: { type: 'noul', instructions: BLOCKED_QUESTION },
      };
      t = performance.now();
      answers = await ctx.s1.decide({ state, questions });
      decideMs = Math.round(performance.now() - t);
      timings.decide = decideMs;
    } catch (error) {
      return finish('failed', 'error', `Decision failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const offered: IterationLine['questions'] = {
      next_action: { type: 'choice', options: Object.keys(optionDescriptions) },
      step_done: { type: 'noul', options: ['true', 'false'] },
      blocked: { type: 'noul', options: ['true', 'false'] },
    };

    // 4a. step_done / blocked.
    const doneRecord = noulRecord('step_done', answers.step_done, modelName, decideMs);
    const blockedRecord = noulRecord('blocked', answers.blocked, modelName, decideMs);
    record(doneRecord);
    record(blockedRecord);
    if ((answers.step_done?.noul ?? 0) >= ctx.thresholds.act) {
      await iterationLine({}, offered);
      return finish('passed', 'step_done', 'Model judged the step fully performed');
    }
    if ((answers.blocked?.noul ?? 0) >= ctx.thresholds.act) {
      await iterationLine({}, offered);
      return finish('blocked', 'blocked', 'Model judged progress blocked');
    }

    // 4b. Pre-gate sensitivity check on the most likely element.
    const next = answers.next_action ?? { probabilities: {}, confidence: 0 };
    emit({
      type: 'observation.elements',
      caseResultId: ctx.caseResultId,
      stepIndex,
      elements: obs.elements.slice(0, MAX_OVERLAY_ELEMENTS).map((e) => ({
        id: e.id,
        role: e.role,
        label: r((e.name || e.text || e.placeholder || '').slice(0, 80)),
        box: e.box,
      })),
      ...(next.choice !== undefined && obs.elementMap.has(next.choice) ? { chosenId: next.choice } : {}),
    });
    const byId = new Map(candidates.map((e) => [e.id, e]));
    // A clickable text block acts like a button, so it is classified as one (a "Delete" div needs approval too).
    const sensitivityOf = (element: ObservedElement): SensitiveCheck =>
      checkSensitive(isTextBlock(element) && element.clickable ? { ...element, role: 'button' } : element, { kind: actionKindOf(element) }, {
        obs,
        ...(step.guards ? { stepGuards: step.guards } : {}),
        requireApprovalFor: ctx.environment.requireApprovalFor,
      });
    const topElement = next.choice === undefined ? undefined : byId.get(next.choice);
    const sensitivity = topElement ? sensitivityOf(topElement) : undefined;
    const sensitiveTrace = (s: SensitiveCheck | undefined): Record<string, unknown> =>
      s && (s.classification || s.blocked)
        ? { sensitive: { classification: s.classification, blocked: s.blocked, ...(s.blockedBy ? { rule: r(s.blockedBy) } : {}) } }
        : {};

    if (sensitivity?.blocked) {
      record(choiceRecord('next_action', Object.keys(optionDescriptions), next, modelName, decideMs));
      await iterationLine(sensitiveTrace(sensitivity), offered);
      return finish('blocked', 'guard', `Step guard "${sensitivity.blockedBy ?? ''}" blocked "${topElement?.name ?? ''}"`);
    }

    // 4c. Gate.
    t = performance.now();
    let verdict: GateResult;
    try {
      const human = attended ? humanHook(sensitivity?.gate !== undefined && sensitivity.gate.allowed !== true) : undefined;
      verdict = await gate(next, {
        thresholds: ctx.thresholds,
        questionId: 'next_action',
        question: `Which single action moves this test step forward: ${safeText}`,
        options: optionDescriptions,
        model: modelName,
        latencyMs: decideMs,
        context: wrapUntrusted(serializeObservation({ ...obs, elements: candidates }, { redactor: ctx.redactor }), { label: 'observation' }),
        attended,
        ...(ctx.s2 ? { s2: ctx.s2 } : {}),
        ...(human ? { human } : {}),
        ...(sensitivity?.gate ? { sensitive: sensitivity.gate } : {}),
      });
    } catch (error) {
      return finish('failed', 'error', `Gate failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    lap('gate', t);
    record(verdict.record);
    const gateTrace = {
      gate: {
        outcome: verdict.outcome,
        ...(verdict.outcome === 'act' ? { choice: verdict.choice } : {}),
        reason: r(verdict.reason),
      },
      ...sensitiveTrace(sensitivity),
    };

    if (verdict.outcome !== 'act') {
      await iterationLine(gateTrace, offered);
      if (verdict.outcome === 'skip') return finish('skipped', 'skipped', verdict.reason);
      if (verdict.outcome === 'abort') return finish('failed', 'aborted', verdict.reason);
      if (verdict.outcome === 'takeover') {
        // The human handed the browser back: look at the page again instead of ending the step.
        if (verdict.resume) continue;
        return finish('blocked', 'takeover', verdict.reason);
      }
      return finish('blocked', sensitivity?.gate && sensitivity.gate.allowed !== true ? 'sensitive' : 'blocked', verdict.reason);
    }
    const choice = verdict.choice;
    if (choice === 'step_done') {
      await iterationLine(gateTrace, offered);
      return finish('passed', 'step_done', 'Model chose step_done');
    }
    if (choice === 'stuck' || choice === 'blocked') {
      await iterationLine(gateTrace, offered);
      return finish('blocked', 'blocked', `Chosen option "${choice}"`);
    }

    // 5. Build the action.
    const element = byId.get(choice);
    let action: EngineAction;
    let target: string | undefined;
    if (element) {
      // A human may have picked a different element than the one pre-checked.
      if (element !== topElement) {
        const second = sensitivityOf(element);
        if (second.blocked || (second.gate && second.gate.allowed !== true)) {
          await iterationLine({ ...gateTrace, ...sensitiveTrace(second) }, offered);
          return second.blocked
            ? finish('blocked', 'guard', `Step guard "${second.blockedBy ?? ''}" blocked "${element.name}"`)
            : finish('blocked', 'sensitive', `Sensitive action (${second.classification ?? 'unknown'}) on "${element.name}" needs approval`);
        }
      }
      target = r(element.name || element.text || element.role);
      const where = { locators: element.locators, ...(element.frame ? { frame: element.frame } : {}) };
      const kind = actionKindOf(element);
      if (kind === 'scroll') {
        action = { kind: 'scroll', dir: 'into-view', ...where };
      } else if (kind === 'fill' || kind === 'selectOption') {
        let resolved;
        // Through the wrapper so a question to the human surfaces as an escalation in the live view.
        const inputHuman = attended ? humanHook(false) : undefined;
        try {
          resolved = await resolveInput({
            element,
            step: { text: safeText, ...(step.inputs ? { inputs: step.inputs } : {}) },
            vars: ctx.vars,
            params: ctx.params,
            s1: ctx.s1,
            ...(ctx.s2 ? { s2: ctx.s2 } : {}),
            ...(inputHuman ? { human: inputHuman } : {}),
            literals,
          });
        } catch (error) {
          await iterationLine(gateTrace, offered);
          return finish('failed', 'error', `Input resolution failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if ('none' in resolved) {
          if (element.role === 'combobox') action = { kind: 'click', ...where };
          else {
            await iterationLine({ ...gateTrace, action: { kind, elementId: element.id, target } }, offered);
            return finish('blocked', 'input', `No test data fits the field "${target}"`);
          }
        } else {
          action = { kind, valueRef: resolved.valueRef, ...where };
        }
      } else {
        action = { kind, ...where };
      }
    } else if (choice === 'scroll_down' || choice === 'scroll_up') {
      action = { kind: 'scroll', dir: choice === 'scroll_down' ? 'down' : 'up' };
    } else if (choice === 'go_back') {
      action = { kind: 'goBack' };
    } else {
      await iterationLine(gateTrace, offered);
      return finish('failed', 'error', `Unknown action option "${choice}"`);
    }

    const actionTrace = {
      kind: action.kind,
      ...(element ? { elementId: element.id } : {}),
      ...(target ? { target } : {}),
      ...('valueRef' in action ? { valueRef: action.valueRef } : {}),
    };

    // 6. Loop guard, then execute.
    const verdictLoop = guard.record(fingerprint, actionKey(action as { kind: string } & Record<string, unknown>));
    if (!verdictLoop.ok) {
      await iterationLine({ ...gateTrace, action: actionTrace }, offered);
      return verdictLoop.reason === 'stuck'
        ? finish('blocked', 'stuck', verdictLoop.message)
        : finish('failed', 'budget', verdictLoop.message);
    }

    t = performance.now();
    let outcome: ActionOutcome;
    try {
      outcome = await execute(ctx.page, action, { ...ctx.executor, resolveValue });
    } catch (error) {
      return finish('failed', 'error', `Executor crashed: ${error instanceof Error ? error.message : String(error)}`);
    }
    lap('execute', t);
    if (outcome.newPage) ctx.page = outcome.newPage.page;

    const errorMessage = outcome.error ? r(outcome.error.message) : undefined;
    history.push({
      stepIndex,
      action: action.kind,
      ...(target ? { target } : {}),
      result: outcome.ok ? 'ok' : `failed: ${outcome.error?.code ?? 'error'}`,
    });
    actions.push({
      ...actionTrace,
      ok: outcome.ok,
      ...(errorMessage ? { error: errorMessage } : {}),
    });
    if (ctx.recorder && outcome.ok) {
      let postFingerprint = fingerprint;
      try {
        postFingerprint = pageFingerprint(await observer.capture(ctx.page, { texts: false }));
      } catch {
        // Page closed or mid-navigation: fall back to the pre fingerprint.
      }
      ctx.recorder.record({
        stepIndex,
        action: action as EngineAction,
        ...(outcome.usedLocator ? { usedLocator: outcome.usedLocator } : {}),
        preFingerprint: fingerprint,
        postFingerprint,
        navigated: outcome.navigated,
      });
    }
    await iterationLine(
      {
        ...gateTrace,
        action: actionTrace,
        outcome: {
          ok: outcome.ok,
          navigated: outcome.navigated,
          durationMs: outcome.durationMs,
          ...(outcome.usedLocator ? { usedLocator: outcome.usedLocator } : {}),
          ...(outcome.error && errorMessage ? { error: { code: outcome.error.code, message: errorMessage } } : {}),
        },
      },
      offered,
    );
  }
}
