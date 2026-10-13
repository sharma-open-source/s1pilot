import { repos, type Db } from '@s1pilot/db';
import type { DecisionRecord, RunEvent, RunStatus, TestRun } from '@s1pilot/domain';

import type { RunEventBus } from '../worker/event-bus.js';

import { encodeFrame, type ScreencastFrame } from './frame.js';
import { ScreencastManager, type ScreencastOptions } from './screencast.js';

/** A connected socket as the hub sees it. */
export interface LiveClient {
  /** Sends a JSON text message. */
  sendText(text: string): void;
  /** Sends a binary screencast frame; may drop it when the client is too slow. */
  sendBinary(data: Buffer): void;
}

/** One step of the case that is currently running, as carried by a snapshot. */
export interface SnapshotStep {
  stepIndex: number;
  action: string;
  status: 'running' | 'passed' | 'failed' | 'blocked' | 'skipped';
  durationMs?: number;
}

/** Sent first to every subscriber of `/ws/runs/:runId`, then followed by live `event` messages. */
export interface RunSnapshot {
  type: 'snapshot';
  run: TestRun;
  currentCase: { caseResultId: string; caseId: string; caseKey?: string } | null;
  steps: SnapshotStep[];
  /** Every case still running with its steps; several at once when the plan runs in parallel. */
  lanes: Array<NonNullable<RunSnapshot['currentCase']> & { steps: SnapshotStep[] }>;
  lastDecision: DecisionRecord | null;
  /** Escalations still waiting for a human, so a reconnecting client can show the prompt again. */
  pendingEscalations: Extract<RunEvent, { type: 'escalation.needed' }>[];
}

/** Messages of `/ws/runs/:runId` (besides binary frames). */
export type RunMessage = RunSnapshot | { type: 'event'; event: RunEvent };

/** Messages of `/ws/workspace`. */
export type WorkspaceMessage =
  /** Sent on connect and whenever a count changes. */
  | { type: 'workspace'; liveRuns: number; reviewCount: number }
  /** A run changed status (`running` on start, the final status on finish). */
  | { type: 'run.status'; runId: string; status: RunStatus };

interface RunState {
  currentCase: RunSnapshot['currentCase'];
  /** Cases started and not finished yet, in start order. */
  running: Map<string, NonNullable<RunSnapshot['currentCase']>>;
  /** Steps per case result; the snapshot shows those of `currentCase`. */
  steps: Map<string, Map<number, SnapshotStep>>;
  lastDecision: DecisionRecord | null;
  escalations: Map<string, Extract<RunEvent, { type: 'escalation.needed' }>>;
}

/** Finished runs whose state is kept for late joiners. */
const KEEP_FINISHED_RUNS = 50;

export interface LiveHubOptions {
  db: Db;
  bus: RunEventBus;
  /** Screencast tuning (tests shorten the fallback interval). */
  screencast?: Omit<ScreencastOptions, 'onFrame'>;
}

/**
 * Per-run fan-out of {@link RunEvent}s and screencast frames to WebSocket clients, plus the lightweight
 * workspace channel. Subscribes to the event bus once and keeps just enough state per run to build a snapshot
 * for late joiners.
 */
export class LiveHub {
  readonly screencast: ScreencastManager;
  private readonly db: Db;
  private readonly runClients = new Map<string, Set<LiveClient>>();
  private readonly workspaceClients = new Set<LiveClient>();
  private readonly states = new Map<string, RunState>();
  private lastWorkspace = '';
  private readonly unsubscribe: () => void;
  private readonly demandListeners = new Set<(runId: string, subscribers: number) => void>();

  constructor(opts: LiveHubOptions) {
    this.db = opts.db;
    this.screencast = new ScreencastManager({
      ...opts.screencast,
      onFrame: (runId, frame) => this.publishFrame(runId, frame),
    });
    this.unsubscribe = opts.bus.subscribe((event) => this.onEvent(event));
  }

  /** Sends a screencast frame to the subscribers of a run. Remote workers (S-068) feed their frames in here. */
  publishFrame(runId: string, frame: ScreencastFrame): void {
    const clients = this.runClients.get(runId);
    if (!clients || clients.size === 0) return;
    const data = encodeFrame(frame);
    for (const c of clients) c.sendBinary(data);
  }

  /** Runs with at least one subscriber and their subscriber counts. */
  demand(): Map<string, number> {
    return new Map([...this.runClients].map(([runId, set]) => [runId, set.size] as const));
  }

  /** Calls `listener` whenever the subscriber count of a run changes (remote workers start/stop their screencast). Returns the remover. */
  onDemand(listener: (runId: string, subscribers: number) => void): () => void {
    this.demandListeners.add(listener);
    return () => void this.demandListeners.delete(listener);
  }

  private setDemand(runId: string, subscribers: number): void {
    this.screencast.setDemand(runId, subscribers);
    for (const l of this.demandListeners) l(runId, subscribers);
  }

  /** Stops listening to the bus. */
  close(): void {
    this.unsubscribe();
    this.runClients.clear();
    this.workspaceClients.clear();
  }

  /**
   * Adds a client to a run: sends the snapshot, then every later event in order. Returns `undefined` when the run
   * does not exist; otherwise the function that removes the client again.
   */
  async subscribeRun(runId: string, client: LiveClient): Promise<(() => void) | undefined> {
    const run = await repos.runs.get(this.db, runId);
    if (!run) return undefined;
    // No await between building the snapshot and registering: no event can fall in the gap or be duplicated.
    client.sendText(JSON.stringify(this.snapshot(run)));
    let set = this.runClients.get(runId);
    if (!set) this.runClients.set(runId, (set = new Set()));
    set.add(client);
    this.setDemand(runId, set.size);
    return () => {
      const current = this.runClients.get(runId);
      if (!current?.delete(client)) return;
      if (current.size === 0) this.runClients.delete(runId);
      this.setDemand(runId, current.size);
    };
  }

  /** Adds a client to the workspace channel and sends the current counts. Returns the remover. */
  async subscribeWorkspace(client: LiveClient): Promise<() => void> {
    const counts = this.counts();
    this.workspaceClients.add(client);
    client.sendText(JSON.stringify({ type: 'workspace', ...counts } satisfies WorkspaceMessage));
    return () => void this.workspaceClients.delete(client);
  }

  /** Re-reads the counts and pushes them when they changed (call after review items change outside a run). */
  notifyWorkspace(): void {
    const counts = this.counts();
    const key = JSON.stringify(counts);
    if (key === this.lastWorkspace) return;
    this.lastWorkspace = key;
    this.broadcastWorkspace({ type: 'workspace', ...counts });
  }

  /** Announces a status change that did not come from the run lifecycle (`paused` / `running`, S-037). */
  announceStatus(runId: string, status: RunStatus): void {
    this.broadcastWorkspace({ type: 'run.status', runId, status });
    this.notifyWorkspace();
  }

  /** Number of clients subscribed to a run (tests). */
  clientCount(runId: string): number {
    return this.runClients.get(runId)?.size ?? 0;
  }

  private counts(): { liveRuns: number; reviewCount: number } {
    const count = (sql: string): number => (this.db.sqlite.prepare(sql).get() as { n: number }).n;
    return {
      liveRuns: count("SELECT COUNT(*) AS n FROM test_runs WHERE status IN ('running', 'paused')"),
      reviewCount: count("SELECT COUNT(*) AS n FROM review_items WHERE status = 'pending'"),
    };
  }

  private broadcastWorkspace(msg: WorkspaceMessage): void {
    const text = JSON.stringify(msg);
    for (const c of this.workspaceClients) c.sendText(text);
  }

  private snapshot(run: TestRun): RunSnapshot {
    const state = this.states.get(run.id);
    const current = state?.currentCase ?? null;
    const stepsOf = (caseResultId: string): SnapshotStep[] =>
      [...(state?.steps.get(caseResultId)?.values() ?? [])].sort((a, b) => a.stepIndex - b.stepIndex);
    return {
      type: 'snapshot',
      run,
      currentCase: current,
      steps: current ? stepsOf(current.caseResultId) : [],
      lanes: [...(state?.running.values() ?? [])].map((c) => ({ ...c, steps: stepsOf(c.caseResultId) })),
      lastDecision: state?.lastDecision ?? null,
      pendingEscalations: [...(state?.escalations.values() ?? [])],
    };
  }

  private track(event: RunEvent): void {
    let state = this.states.get(event.runId);
    if (!state) {
      state = { currentCase: null, running: new Map(), steps: new Map(), lastDecision: null, escalations: new Map() };
      this.states.set(event.runId, state);
    }
    switch (event.type) {
      case 'case.started':
        state.currentCase = { caseResultId: event.caseResultId, caseId: event.caseId, ...(event.caseKey ? { caseKey: event.caseKey } : {}) };
        state.running.set(event.caseResultId, state.currentCase);
        state.steps.set(event.caseResultId, new Map());
        break;
      case 'case.finished':
        state.running.delete(event.caseResultId);
        break;
      case 'step.started': {
        const steps = state.steps.get(event.caseResultId) ?? new Map<number, SnapshotStep>();
        state.steps.set(event.caseResultId, steps);
        steps.set(event.stepIndex, { stepIndex: event.stepIndex, action: event.action, status: 'running' });
        break;
      }
      case 'step.finished': {
        const step = state.steps.get(event.caseResultId)?.get(event.stepIndex);
        if (step) {
          step.status = event.status;
          step.durationMs = event.durationMs;
        }
        break;
      }
      case 'decision.made':
        state.lastDecision = event.decision;
        break;
      case 'escalation.needed':
        state.escalations.set(event.escalationId, event);
        break;
      case 'escalation.resolved':
        state.escalations.delete(event.escalationId);
        break;
      default:
        break;
    }
  }

  private onEvent(event: RunEvent): void {
    this.track(event);
    const clients = this.runClients.get(event.runId);
    if (clients && clients.size > 0) {
      const text = JSON.stringify({ type: 'event', event } satisfies RunMessage);
      for (const c of clients) c.sendText(text);
    }
    if (event.type === 'run.started') this.broadcastWorkspace({ type: 'run.status', runId: event.runId, status: 'running' });
    if (event.type === 'run.finished') {
      this.broadcastWorkspace({ type: 'run.status', runId: event.runId, status: event.status });
      this.evict();
    }
    if (event.type === 'run.started' || event.type === 'run.finished' || event.type === 'case.finished') this.notifyWorkspace();
  }

  private evict(): void {
    if (this.states.size <= KEEP_FINISHED_RUNS) return;
    // Maps iterate in insertion order: drop the oldest runs that have no subscribers.
    for (const id of this.states.keys()) {
      if (this.states.size <= KEEP_FINISHED_RUNS) break;
      if (!this.runClients.has(id)) this.states.delete(id);
    }
  }
}
