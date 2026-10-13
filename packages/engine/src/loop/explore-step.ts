import {
  newId,
  S1PilotError,
  type DecideAnswer,
  type DecisionRecord,
  type LocatorCandidate,
  type EscalationTarget,
  type Question,
  type RunEvent,
} from '@s1pilot/domain';

import { gate, type GateResult } from '../decide/gate.js';
import type { HumanHook } from '../decide/human.js';
import { execute, trackRequests, waitWhileBusy } from '../executor/index.js';
import { inferAction } from '../executor/infer.js';
import type { ActionOutcome, EngineAction } from '../executor/types.js';
import { actionKey, LoopGuard } from '../guards/loop.js';
import { checkSensitive, type SensitiveCheck } from '../guards/sensitive.js';
import { wrapUntrusted } from '../guards/untrusted.js';
import { lexicalScore, matchingTexts, tokenize } from '../narrow/lexical.js';
import { narrow } from '../narrow/narrow.js';
import { ActionHistory } from '../observer/history.js';
import { observer, pageFingerprint, serializeObservation, type Observation } from '../observer/observation.js';
import { isTextBlock, type ObservedElement } from '../observer/types.js';
import { FILE_REF_PREFIX, bindParams, createLiteralStore, createValueResolver, quotedValues, resolveInput } from '../text-input/index.js';
import { TraceLineSchema, type StepEnd, type TraceLine } from '../trace/schema.js';

import { stepIntent } from './intent.js';
import type { EngineContext, ExecutedAction, ExploreStepInput, StepExecution } from './types.js';
import { describeWait, parseWait, performWait } from './wait.js';

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
const BLOCKED_QUESTION =
  'Is this test step impossible to carry out here (error page, captcha, or a login wall that the step itself does not log in through)?';
/** Waits when the model finds nothing to do (yet): content may still be appearing. */
const SETTLE_RETRIES = 2;
const SETTLE_WAIT_MS = 3000;
/** Before the step has acted, how long an idle page (no request in flight) may take to change. */
const IDLE_SETTLE_MS = 500;

/** Same element across two captures: a shared test id or CSS path (names may change, "Volume: 50%" → "90%"). */
function sameElement(a: readonly LocatorCandidate[], b: readonly LocatorCandidate[]): boolean {
  const stable = (l: LocatorCandidate): boolean => l.kind === 'testId' || l.kind === 'css';
  return a.some((x) => stable(x) && b.some((y) => y.kind === x.kind && y.value === x.value)) || JSON.stringify(a) === JSON.stringify(b);
}

/** Resolves on the next DOM mutation of the page, or after `ms`; true when the page changed. Never throws. */
async function waitForDomChange(page: EngineContext['page'], ms: number): Promise<boolean> {
  return page
    .evaluate(
      (limit) =>
        new Promise<boolean>((resolve) => {
          const done = (changed: boolean): void => {
            mo.disconnect();
            clearTimeout(timer);
            // Let the change finish rendering before the next observation.
            setTimeout(() => resolve(changed), changed ? 300 : 0);
          };
          const mo = new MutationObserver(() => done(true));
          mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
          const timer = setTimeout(() => done(false), limit);
        }),
      ms,
    )
    // The document went away (a navigation): the page did change.
    .catch(() => true);
}

/**
 * What choosing an element does. Text blocks are clicked when they look clickable (pointer cursor,
 * typically a script click handler) and otherwise scrolled into view; controls follow {@link inferAction}.
 */
function actionKindOf(element: ObservedElement): ReturnType<typeof inferAction> | 'scroll' | 'upload' {
  if (isTextBlock(element)) return element.clickable ? 'click' : 'scroll';
  if (element.inputType === 'file') return 'upload';
  return inferAction(element, true);
}

/** Meta option offered when the step names a key to press. */
const PRESS_KEY = 'press_key';
/** Upper bound of page text blocks offered as drop targets. */
const MAX_DROP_TEXTS = 15;
const DROP_QUESTION = 'Where should the dragged element be dropped for this test step?';

/** Option label for the `next_action` question. */
function describeOption(element: ObservedElement, actedOn = false): string {
  const base = element.name || element.text || element.placeholder || '';
  const near = element.nearLabel ? `near "${element.nearLabel}"` : '';
  const shown = base ? [base, near].filter(Boolean).join(' ') : near || (element.idHint ? `(${element.idHint})` : '');
  let label = `[${element.role}] ${shown}`.trim();
  if (element.range) label += ` (slider ${element.range.min}-${element.range.max})`;
  else if (element.inputType) label += ` (${element.inputType} field)`;
  if (element.empty) label += ' (empty)';
  if (element.inPage) label += ' (in-page link: only scrolls to that section)';
  // Without this the model tends to pick the element it just filled or clicked again.
  if (actedOn) label += ' (already acted on in this step)';
  // Same-named controls ("Upload", "Add to Cart") differ only by the card they sit in.
  if (element.section) label += ` in "${element.section.length > 40 ? `${element.section.slice(0, 39)}…` : element.section}"`;
  if (!isTextBlock(element)) return label;
  return `${label} (${element.clickable ? 'click it' : 'scroll it into view'})`;
}

type EventBody = RunEvent extends infer E ? (E extends { type: string } ? Omit<E, 'runId' | 'ts'> : never) : never;
type IterationLine = Extract<TraceLine, { kind: 'iteration' }>;


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

function choiceRecord(id: string, labels: Record<string, string>, answer: DecideAnswer | undefined, model: string, latencyMs: number): DecisionRecord {
  return {
    questionId: id,
    options: Object.keys(labels),
    optionLabels: { ...labels },
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
  const resolveValue = createValueResolver({ vars: ctx.vars, params: ctx.params, literals, stepText: text });
  guard.beginCaseStep();

  const attended = ctx.attended ?? ctx.human !== undefined;
  const decisions: DecisionRecord[] = [];
  const actions: ExecutedAction[] = [];
  // How the step wants things done beyond click/fill (double-click, drag, key, upload), from its wording.
  const intent = stepIntent(text);
  let pointerUsed = false;
  let pressed = false;
  let dragged = false;
  /** Locators of the element the last successful action targeted (a repeat pick hints the step is done). */
  let lastTarget: readonly LocatorCandidate[] | undefined;
  /** Locators of every element this step acted on successfully. */
  const actedLocators: (readonly LocatorCandidate[])[] = [];
  let settles = 0;
  /**
   * The model found nothing to do (yet): the page may still be updating (a button that appears
   * after an action, content behind a loader). Waits for a change and says whether to look again.
   * Before the step has acted, an idle page (no request in flight) gets only a short look, so an
   * unsure model or a really blocked step is not slowed down.
   */
  const settle = async (): Promise<boolean> => {
    if (settles >= SETTLE_RETRIES) return false;
    settles += 1;
    if (actions.some((x) => x.ok)) {
      await waitForDomChange(ctx.page, SETTLE_WAIT_MS);
      return true;
    }
    return waitForDomChange(ctx.page, trackRequests(ctx.page).size > 0 ? SETTLE_WAIT_MS : IDLE_SETTLE_MS);
  };
  let cleared = false;
  const quotedTexts = quotedValues(text).map((v) => v.toLowerCase());
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

  // A pure wait step ("Wait 5 seconds", "Wait until "Saved" appears") needs no model: just wait.
  const wait = parseWait(text);
  if (wait) {
    const waited = await performWait(ctx.page, wait);
    actions.push({ kind: 'wait', target: describeWait(wait), ok: waited.ok, ...(waited.message ? { error: r(waited.message) } : {}) });
    return waited.ok ? finish('passed', 'step_done') : finish('failed', 'error', waited.message);
  }

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

    // 1. Observe (once any loader on the page has gone).
    let t = performance.now();
    await waitWhileBusy(ctx.page);
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
      // Page text equal to a value quoted in the step ("choose "High"") is a target too: custom
      // dropdown options and suggestions are often plain list items.
      // Hover / right-click / drag targets are often plain page text ("Right-click anywhere in this
      // area"), so those steps get a lower bar for offering text blocks.
      const gesture = (intent.pointer && !pointerUsed) || (intent.drag && !dragged);
      const lexical = matchingTexts(obs.texts ?? [], safeText, undefined, gesture ? 0.25 : undefined);
      const exact = (obs.texts ?? []).filter((t) => !lexical.includes(t) && quotedTexts.includes((t.text ?? t.name).trim().toLowerCase()));
      const pool = [...obs.elements, ...lexical, ...exact.slice(0, 5)];
      // Options added beyond narrow's own meta reserve (press_key) must fit within maxOptions too.
      const extraOptions = intent.key && !pressed ? 1 : 0;
      const narrowed = await narrow({ elements: pool }, { maxOptions: ctx.caps.maxOptions - extraOptions }, ctx.s1, safeText, { modelName });
      lap('narrow', t);
      // Region labels carry page text: redact them before they reach events, traces and reports.
      narrowed.trail.forEach((d) =>
        record(d.optionLabels ? { ...d, optionLabels: Object.fromEntries(Object.entries(d.optionLabels).map(([k, v]) => [k, r(v)])) } : d),
      );
      candidates = narrowed.candidates;
      const actedOnIds = new Set(candidates.filter((c) => actedLocators.some((l) => sameElement(c.locators, l))).map((c) => c.id));
      for (const e of candidates) optionDescriptions[e.id] = r(describeOption(e, actedOnIds.has(e.id)));
      Object.assign(optionDescriptions, META_DESCRIPTIONS);
      if (intent.key && !pressed) optionDescriptions[PRESS_KEY] = `Press the ${intent.key} key (on the focused element)`;

      const shown: Observation = { ...obs, elements: candidates };
      const state = {
        step: safeText,
        // What this step already did, so "is it done?" does not rely on spotting it in the page.
        done_in_this_step: actions.filter((a) => a.ok).map((a) => r(`${a.kind} ${a.target ?? ''}`.trim())),
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
      // The model server's own message (a 400 body) says what it rejected; finish() redacts it.
      const snippet = error instanceof S1PilotError && typeof error.details?.snippet === 'string' ? ` (${error.details.snippet.slice(0, 300)})` : '';
      return finish('failed', 'error', `Decision failed: ${error instanceof Error ? error.message : String(error)}${snippet}`);
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
    const confidentPick = answers.next_action?.choice !== undefined && !(answers.next_action.choice in META_DESCRIPTIONS) && answers.next_action.confidence >= ctx.thresholds.act;
    if ((answers.blocked?.noul ?? 0) >= ctx.thresholds.act && !confidentPick) {
      await iterationLine({}, offered);
      return finish('blocked', 'blocked', 'Model judged progress blocked');
    }
    // After this step already acted, two answers agreeing that it is done (next_action picks
    // `step_done` and the step_done question leans true, both at least `escalate`) end it. Finishing
    // performs nothing, and the step's expectation is still verified afterwards.
    // Likewise when it leans done and the top pick merely repeats the element just acted on (a second
    // click on the same "Confirm"), which needs a stronger lean: halfway between escalate and act.
    const nextAnswer = answers.next_action;
    const doneP = answers.step_done?.noul ?? 0;
    const repeatPick =
      nextAnswer?.choice !== undefined && lastTarget !== undefined && candidates.some((c) => c.id === nextAnswer.choice && sameElement(c.locators, lastTarget as LocatorCandidate[]));
    if (
      actions.some((a) => a.ok) &&
      ((nextAnswer?.choice === 'step_done' && doneP >= ctx.thresholds.escalate) ||
        (repeatPick && doneP >= (ctx.thresholds.escalate + ctx.thresholds.act) / 2))
    ) {
      record(choiceRecord('next_action', optionDescriptions, nextAnswer, modelName, decideMs));
      await iterationLine({}, offered);
      return finish('passed', 'step_done', 'Model judged the step performed (next action and step-done answers agree)');
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
        label: r((e.name || e.text || e.placeholder || e.nearLabel || '').slice(0, 80)),
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
      record(choiceRecord('next_action', optionDescriptions, next, modelName, decideMs));
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
      const sensitiveStop = sensitivity?.gate !== undefined && sensitivity.gate.allowed !== true;
      if (!sensitiveStop && (await settle())) continue;
      return finish('blocked', sensitiveStop ? 'sensitive' : 'blocked', verdict.reason);
    }
    const choice = verdict.choice;
    if (choice === 'step_done') {
      await iterationLine(gateTrace, offered);
      return finish('passed', 'step_done', 'Model chose step_done');
    }
    if (choice === 'stuck' || choice === 'blocked') {
      await iterationLine(gateTrace, offered);
      if (await settle()) continue;
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
      const pointer = intent.pointer && !pointerUsed && (kind === 'click' || kind === 'scroll') ? intent.pointer : undefined;
      if (intent.drag && !dragged && kind !== 'fill' && kind !== 'selectOption' && kind !== 'upload') {
        // 5a. Drag: ask where the chosen element goes, among the other candidates and matching page text.
        const tokens = tokenize(safeText);
        const texts = (obs.texts ?? [])
          .map((t) => ({ t, s: lexicalScore(tokens, t) }))
          .filter((x) => x.s > 0)
          .sort((x, y) => y.s - x.s)
          .slice(0, MAX_DROP_TEXTS)
          .map((x) => x.t);
        const drops = [...candidates.filter((c) => c.id !== element.id && !isTextBlock(c)), ...texts].slice(0, Math.max(2, ctx.caps.maxOptions - 2));
        const dropOptions: Record<string, string> = Object.fromEntries(drops.map((d) => [d.id, r(describeOption(d))]));
        dropOptions.stuck = META_DESCRIPTIONS.stuck as string;
        let dropVerdict: GateResult;
        const dropHuman = attended ? humanHook(false) : undefined;
        try {
          const t0 = performance.now();
          const dropAnswers = await ctx.s1.decide({
            state: { step: safeText, dragging: r(describeOption(element)) },
            questions: { drop_target: { type: 'choice', instructions: DROP_QUESTION, criteria: dropOptions } },
          });
          const dropAnswer = dropAnswers.drop_target ?? { probabilities: {}, confidence: 0 };
          dropVerdict = await gate(dropAnswer, {
            thresholds: ctx.thresholds,
            questionId: 'drop_target',
            question: DROP_QUESTION,
            options: dropOptions,
            model: modelName,
            latencyMs: Math.round(performance.now() - t0),
            context: wrapUntrusted(serializeObservation({ ...obs, elements: drops }, { redactor: ctx.redactor }), { label: 'observation' }),
            attended,
            ...(ctx.s2 ? { s2: ctx.s2 } : {}),
            ...(dropHuman ? { human: dropHuman } : {}),
          });
        } catch (error) {
          await iterationLine(gateTrace, offered);
          return finish('failed', 'error', `Drop target decision failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        record(dropVerdict.record);
        const drop = dropVerdict.outcome === 'act' ? drops.find((d) => d.id === dropVerdict.choice) : undefined;
        if (!drop) {
          await iterationLine(gateTrace, offered);
          return finish('blocked', 'blocked', `No drop target chosen: ${dropVerdict.reason}`);
        }
        action = { kind: 'drag', ...where, target: { locators: drop.locators, ...(drop.frame ? { frame: drop.frame } : {}) } };
      } else if (kind === 'upload' || (intent.upload && kind === 'click')) {
        // 5b. Upload: a file input, or a "browse" control whose file chooser is answered. The file is a
        // generated sample named as quoted in the step ("photo.png").
        action = { kind: 'upload', fileRef: `${FILE_REF_PREFIX}${intent.upload ?? 'sample.txt'}`, ...where };
      } else if (pointer) {
        // 5c. Hover / double-click / right-click: only the first click-like action of the step, so
        // "right-click the area and choose Copy" right-clicks once and then clicks Copy.
        action = { kind: pointer, ...where };
      } else if (kind === 'scroll') {
        action = { kind: 'scroll', dir: 'into-view', ...where };
      } else if (kind === 'check' && intent.off) {
        // "Turn off autoplay": untick (check() on a ticked box would do nothing).
        action = { kind: 'uncheck', ...where };
      } else if (kind === 'fill' && intent.clear && !cleared && element.value) {
        // "Clear the search": empty a field that holds text.
        action = { kind: 'fill', valueRef: 'empty:', ...where };
      } else if (kind === 'fill' || kind === 'selectOption') {
        let resolved;
        // Through the wrapper so a question to the human surfaces as an escalation in the live view.
        const inputHuman = attended ? humanHook(false) : undefined;
        try {
          resolved = await resolveInput({
            element,
            step: { text: safeText, raw: text, ...(step.inputs ? { inputs: step.inputs } : {}) },
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
    } else if (choice === PRESS_KEY && intent.key) {
      action = { kind: 'press', key: intent.key };
      target = intent.key;
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
    if (outcome.ok) {
      if (action.kind === 'hover' || action.kind === 'dblclick' || action.kind === 'rightclick') pointerUsed = true;
      if (action.kind === 'press') pressed = true;
      if (action.kind === 'drag') dragged = true;
      lastTarget = element ? element.locators : undefined;
      if (element) actedLocators.push(element.locators);
      if (action.kind === 'fill' && action.valueRef === 'empty:') cleared = true;
    }

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
