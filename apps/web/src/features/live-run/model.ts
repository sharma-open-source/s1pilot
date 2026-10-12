import type { CaseMode, DecisionRecord, RunControlMessage, RunEvent, RunStatus, RunSummary, TestRun } from '@s1pilot/domain';

/** `escalation.needed` event as the panel sees it. */
export type Escalation = Extract<RunEvent, { type: 'escalation.needed' }>;

/** One step of the running case. */
export interface LiveStepRow {
  index: number;
  action: string;
  status: 'running' | 'passed' | 'failed' | 'blocked' | 'skipped';
  /** True once a decision was made for the step (it was not a plain replay). */
  decided: boolean;
}

/** One overlay box, in viewport CSS pixels. */
export interface OverlayElement {
  id: string;
  role: string;
  label: string;
  box: { x: number; y: number; w: number; h: number };
}

/** One line of the event log. */
export interface LogLine {
  id: number;
  time: string;
  text: string;
  warn: boolean;
  /** Set for `log` events so the console/network drawer can filter. */
  level?: 'debug' | 'info' | 'warn' | 'error';
  message?: string;
}

export interface LiveRunState {
  /** True once a snapshot arrived on the current connection. */
  ready: boolean;
  run: TestRun | null;
  currentCase: { caseResultId: string; caseId: string; caseKey?: string; mode?: CaseMode } | null;
  steps: LiveStepRow[];
  lastDecision: (DecisionRecord & { stepIndex?: number }) | null;
  pending: Escalation[];
  elements: OverlayElement[];
  chosenId: string | null;
  /** Last URL seen in a log event. */
  url: string | null;
  log: LogLine[];
  nextLogId: number;
  finished: { status: RunStatus; summary: RunSummary } | null;
  totalCases: number | null;
}

export const INITIAL_LIVE_STATE: LiveRunState = {
  ready: false,
  run: null,
  currentCase: null,
  steps: [],
  lastDecision: null,
  pending: [],
  elements: [],
  chosenId: null,
  url: null,
  log: [],
  nextLogId: 1,
  finished: null,
  totalCases: null,
};

const MAX_LOG = 500;
const TERMINAL: RunStatus[] = ['finished', 'aborted', 'passed', 'failed', 'needs-review', 'cancelled', 'error'];

/** True for statuses a run never leaves. */
export function isTerminal(status: RunStatus | undefined): boolean {
  return status !== undefined && TERMINAL.includes(status);
}

/** `hh:mm:ss` (UTC) of an ISO timestamp. */
export function clock(ts: string): string {
  return /T(\d\d:\d\d:\d\d)/.exec(ts)?.[1] ?? '--:--:--';
}

function pct(p: number): string {
  return p.toFixed(2);
}

/** Top option of an escalation by probability. */
export function topOption(esc: Pick<Escalation, 'probabilities'>): { id: string; p: number } | null {
  const entries = Object.entries(esc.probabilities ?? {}).sort((a, b) => b[1] - a[1]);
  const first = entries[0];
  return first !== undefined ? { id: first[0], p: first[1] } : null;
}

/** One-line description of an event, as in the wireframe's event log. `warn` marks escalations. */
export function describeEvent(ev: RunEvent, caseKey: string | undefined): { text: string; warn: boolean } {
  const c = caseKey ?? 'case';
  switch (ev.type) {
    case 'run.started':
      return { text: `run started · ${ev.totalCases} case${ev.totalCases === 1 ? '' : 's'}`, warn: false };
    case 'case.started':
      return { text: `${ev.caseKey ?? c} started`, warn: false };
    case 'step.started':
      return { text: `${c} step ${ev.stepIndex + 1} · ${ev.action}`, warn: false };
    case 'decision.made': {
      const d = ev.decision;
      const target = d.escalatedTo !== undefined ? ` → ${d.escalatedTo}` : '';
      return { text: `${d.model} top=${d.chosen ?? 'none'} conf=${pct(d.confidence)} (${Math.round(d.latencyMs)} ms)${target}`, warn: false };
    }
    case 'observation.elements':
      return { text: `observe · ${ev.elements.length} elements${ev.chosenId !== undefined ? ` · chosen ${ev.chosenId}` : ''}`, warn: false };
    case 'assertion.verdict': {
      const v = ev.verdict;
      const p = v.probability !== undefined ? ` P(true)=${pct(v.probability)}` : '';
      const word = v.verdict === 'pass' ? 'passed' : v.verdict === 'fail' ? 'failed' : 'needs review';
      return { text: `${c} step ${ev.stepIndex + 1} assertion ${v.assertion} ${word}${p}`, warn: v.verdict === 'needs-review' };
    }
    case 'escalation.needed': {
      const top = topOption(ev);
      const conf = top !== null ? ` top=${top.id} conf=${pct(top.p)}` : '';
      const s2 = ev.s2Choice !== undefined ? ` → S2 second opinion: ${ev.s2Choice}` : '';
      return { text: `${c} step ${ev.stepIndex + 1} escalation (${ev.reason})${conf}${s2} · awaiting ${ev.to === 'human' ? 'approval' : ev.to}`, warn: true };
    }
    case 'escalation.resolved':
      return { text: `escalation ${ev.resolution}${ev.chosen !== undefined ? ` · ${ev.chosen}` : ''} by ${ev.by}`, warn: ev.resolution === 'timed-out' || ev.resolution === 'aborted' };
    case 'step.finished':
      return { text: `${c} step ${ev.stepIndex + 1} ${ev.status} (${Math.round(ev.durationMs)} ms)`, warn: false };
    case 'case.finished':
      return { text: `${c} finished · ${ev.verdict} (${Math.round(ev.durationMs)} ms)`, warn: false };
    case 'run.finished':
      return { text: `run finished · ${ev.status} · ${ev.summary.passed} passed, ${ev.summary.failed} failed`, warn: false };
    case 'log':
      return { text: ev.message, warn: ev.level === 'warn' || ev.level === 'error' };
  }
}

function upsertStep(steps: LiveStepRow[], row: LiveStepRow): LiveStepRow[] {
  const next = steps.filter((s) => s.index !== row.index);
  next.push(row);
  return next.sort((a, b) => a.index - b.index);
}

function addLog(state: LiveRunState, ev: RunEvent): LiveRunState {
  const { text, warn } = describeEvent(ev, state.currentCase?.caseKey);
  const line: LogLine = {
    id: state.nextLogId,
    time: clock(ev.ts),
    text,
    warn,
    ...(ev.type === 'log' ? { level: ev.level, message: ev.message } : {}),
  };
  const log = [...state.log, line];
  return { ...state, log: log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log, nextLogId: state.nextLogId + 1 };
}

const URL_RE = /https?:\/\/[^\s"'<>)]+/;

/** Applies one event to the state. */
export function applyEvent(prev: LiveRunState, ev: RunEvent): LiveRunState {
  let s = prev;
  switch (ev.type) {
    case 'run.started':
      s = { ...s, totalCases: ev.totalCases, run: s.run ? { ...s.run, status: 'running' } : s.run };
      break;
    case 'case.started':
      s = {
        ...s,
        currentCase: {
          caseResultId: ev.caseResultId,
          caseId: ev.caseId,
          ...(ev.caseKey !== undefined ? { caseKey: ev.caseKey } : {}),
          ...(ev.mode !== undefined ? { mode: ev.mode } : {}),
        },
        steps: [],
        elements: [],
        chosenId: null,
        lastDecision: null,
        pending: [],
      };
      break;
    case 'step.started':
      s = { ...s, steps: upsertStep(s.steps, { index: ev.stepIndex, action: ev.action, status: 'running', decided: false }) };
      break;
    case 'decision.made': {
      const existing = s.steps.find((x) => x.index === ev.stepIndex);
      s = {
        ...s,
        lastDecision: { ...ev.decision, stepIndex: ev.stepIndex },
        steps: existing ? upsertStep(s.steps, { ...existing, decided: true }) : s.steps,
      };
      break;
    }
    case 'observation.elements':
      s = { ...s, elements: ev.elements, chosenId: ev.chosenId ?? null };
      break;
    case 'escalation.needed':
      s = { ...s, pending: [...s.pending.filter((e) => e.escalationId !== ev.escalationId), ev] };
      break;
    case 'escalation.resolved':
      s = { ...s, pending: s.pending.filter((e) => e.escalationId !== ev.escalationId) };
      break;
    case 'step.finished': {
      const existing = s.steps.find((x) => x.index === ev.stepIndex);
      s = {
        ...s,
        steps: upsertStep(s.steps, { index: ev.stepIndex, action: existing?.action ?? '', decided: existing?.decided ?? false, status: ev.status }),
      };
      break;
    }
    case 'run.finished':
      s = {
        ...s,
        finished: { status: ev.status, summary: ev.summary },
        pending: [],
        run: s.run ? { ...s.run, status: ev.status, summary: ev.summary } : s.run,
      };
      break;
    case 'log': {
      const url = URL_RE.exec(ev.message)?.[0];
      if (url !== undefined) s = { ...s, url };
      break;
    }
    case 'case.finished':
      break;
  }
  return addLog(s, ev);
}

/** Replaces the state with a `snapshot` message; the log and URL survive a reconnect. */
export function applySnapshot(prev: LiveRunState, snap: Record<string, unknown>): LiveRunState {
  const run = snap['run'] as TestRun | undefined;
  const steps = Array.isArray(snap['steps']) ? (snap['steps'] as Array<{ stepIndex: number; action: string; status: LiveStepRow['status'] }>) : [];
  const last = (snap['lastDecision'] ?? null) as DecisionRecord | null;
  const pending = Array.isArray(snap['pendingEscalations']) ? (snap['pendingEscalations'] as Escalation[]) : [];
  return {
    ...prev,
    ready: true,
    run: run ?? null,
    currentCase: (snap['currentCase'] ?? null) as LiveRunState['currentCase'],
    steps: steps.map((x) => ({ index: x.stepIndex, action: x.action, status: x.status, decided: false })).sort((a, b) => a.index - b.index),
    lastDecision: last,
    pending,
    finished: run !== undefined && isTerminal(run.status) ? { status: run.status, summary: run.summary } : null,
  };
}

/** Applies one parsed text message from `/ws/runs/:id`; unknown shapes are ignored. */
export function applyMessage(state: LiveRunState, raw: unknown): LiveRunState {
  if (typeof raw !== 'object' || raw === null) return state;
  const msg = raw as Record<string, unknown>;
  if (msg['type'] === 'snapshot') return applySnapshot(state, msg);
  if (msg['type'] === 'event' && typeof msg['event'] === 'object' && msg['event'] !== null) return applyEvent(state, msg['event'] as RunEvent);
  return state;
}

/** Decoded binary screencast frame. */
export interface DecodedFrame {
  resultId: string;
  seq: number;
  width: number;
  height: number;
  jpeg: Uint8Array;
}

/**
 * Browser-side inverse of the server's `encodeFrame`: `[idLen u8][seq u32][width u16][height u16][resultId][jpeg]`.
 * Returns `null` for a truncated buffer.
 */
export function decodeFrameBytes(buf: ArrayBuffer): DecodedFrame | null {
  if (buf.byteLength < 9) return null;
  const view = new DataView(buf);
  const idLen = view.getUint8(0);
  const start = 9 + idLen;
  if (buf.byteLength < start) return null;
  return {
    resultId: new TextDecoder().decode(new Uint8Array(buf, 9, idLen)),
    seq: view.getUint32(1),
    width: view.getUint16(5),
    height: view.getUint16(7),
    jpeg: new Uint8Array(buf, start),
  };
}

/** One row of the probability list. */
export interface OptionRow {
  id: string;
  label: string;
  p: number;
}

/** What the decision panel shows. */
export interface DecisionView {
  /** 1-based step number. */
  step: number | null;
  model: string | null;
  latencyMs: number | null;
  question: string | null;
  /** Top five options by probability. */
  rows: OptionRow[];
  /** Every option, including meta actions, for "Pick another". */
  allOptions: OptionRow[];
  /** The option Approve confirms. */
  approveId: string | null;
  callout: { title: string; body: string } | null;
  escalationId: string | null;
}

const REASON_TITLE: Record<Escalation['reason'], string> = {
  'low-confidence': 'Below act threshold',
  stuck: 'System 1 is stuck',
  blocked: 'Step is blocked',
  'sensitive-action': 'Sensitive action needs approval',
};

function labelFor(id: string, labels: Record<string, string> | undefined, elements: OverlayElement[]): string {
  const text = labels?.[id] ?? elements.find((e) => e.id === id)?.label;
  return text !== undefined && text !== '' ? `${id} · ${text}` : id;
}

/** Builds the panel from the first pending escalation, else from the last decision (read-only). */
export function buildDecisionView(state: LiveRunState): DecisionView | null {
  const esc = state.pending[0];
  const last = state.lastDecision;
  if (esc !== undefined) {
    const probs = esc.probabilities ?? {};
    const ids = [...new Set([...Object.keys(probs), ...esc.options, ...Object.keys(esc.optionLabels ?? {})])];
    const all = ids
      .map((id) => ({ id, label: labelFor(id, esc.optionLabels, state.elements), p: probs[id] ?? 0 }))
      .sort((a, b) => b.p - a.p);
    const top = all[0];
    const approveId = esc.s2Choice ?? top?.id ?? null;
    const act = esc.thresholds?.['act'];
    const title = esc.reason === 'low-confidence' && act !== undefined ? `${REASON_TITLE[esc.reason]} (${act.toFixed(2)})` : REASON_TITLE[esc.reason];
    const s2 = esc.s2Choice !== undefined ? `System 2 asked → ${esc.s2Choice === top?.id ? 'also picks' : 'picks'} ${esc.s2Choice}. ` : '';
    return {
      step: esc.stepIndex + 1,
      model: last?.model ?? null,
      latencyMs: last?.latencyMs ?? null,
      question: esc.question ?? null,
      rows: all.slice(0, 5),
      allOptions: all,
      approveId,
      callout: { title, body: `${s2}${esc.detail ?? 'Waiting for your approval.'}` },
      escalationId: esc.escalationId,
    };
  }
  if (last !== null) {
    const ids = [...new Set([...last.options, ...Object.keys(last.probabilities)])];
    const all = ids
      .map((id) => ({ id, label: labelFor(id, undefined, state.elements), p: last.probabilities[id] ?? 0 }))
      .sort((a, b) => b.p - a.p);
    return {
      step: last.stepIndex !== undefined ? last.stepIndex + 1 : null,
      model: last.model,
      latencyMs: last.latencyMs,
      question: null,
      rows: all.slice(0, 5),
      allOptions: all,
      approveId: null,
      callout: null,
      escalationId: null,
    };
  }
  return null;
}

/** Progress-bar counts from the run's case results. */
export interface ProgressCounts {
  passed: number;
  failed: number;
  review: number;
  queued: number;
  total: number;
}

/** Counts from `runs.get` output: verdicts of finished cases; everything else is queued/running. */
export function progressCounts(results: Array<{ verdict: string }>, totalJobs: number): ProgressCounts {
  let passed = 0;
  let failed = 0;
  let review = 0;
  for (const r of results) {
    if (r.verdict === 'passed') passed += 1;
    else if (r.verdict === 'failed' || r.verdict === 'blocked') failed += 1;
    else if (r.verdict === 'needs-review' || r.verdict === 'flaky') review += 1;
  }
  const total = Math.max(totalJobs, results.length);
  return { passed, failed, review, queued: Math.max(0, total - passed - failed - review), total };
}

/**
 * Mode suffix of a step row: `replay`, `heal`, or `explore`. A case that starts in `explore` (no usable
 * learned script, e.g. after its steps changed) explores every step even under a `replay-heal` plan.
 */
export function stepMode(row: LiveStepRow, runMode: string | undefined, caseMode?: CaseMode): string {
  if (runMode === 'explore' || caseMode === 'explore') return 'explore';
  if (!row.decided) return 'replay';
  return runMode === 'replay-only' ? 'replay' : 'heal';
}

/** Approve message for the escalation. */
export function approveMessage(escalationId: string, choice: string, saveToLearned: boolean): RunControlMessage {
  return { type: 'approve', escalationId, choice, saveToLearned };
}
