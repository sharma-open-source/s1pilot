import { repos, type Db } from '@s1pilot/db';
import { S1PilotError, newId, type RunControlMessage, type RunStatus } from '@s1pilot/domain';
import {
  HUMAN_UNAVAILABLE,
  type HumanAskRequest,
  type HumanHook,
  type HumanResponse,
} from '@s1pilot/engine';
import { launchBrowser, type RunCasesInput } from '@s1pilot/runner';
import type { FastifyBaseLogger } from 'fastify';

import type { ServerConfig } from '../config.js';
import type { RunEventBus } from '../worker/event-bus.js';
import { isTerminalRunStatus, type RunLifecycle } from '../worker/run-lifecycle.js';

type Page = Parameters<NonNullable<RunCasesInput['onPage']>>[0];
type Browser = Awaited<ReturnType<typeof launchBrowser>>;
type Decided = { decidedBy: string; via: 'live' };

/** Dependencies of {@link HumanControl}. */
export interface HumanControlOptions {
  db: Db;
  bus: RunEventBus;
  config: ServerConfig;
  lifecycle: RunLifecycle;
  log: FastifyBaseLogger;
  /** Cancels the run and stops its workers (what `runs.cancel` does). */
  abortRun: (runId: string) => Promise<void>;
  /** Called when a control message changed the run status (`paused` / `running`). */
  onStatus?: (runId: string, status: RunStatus) => void;
  /** Opens the visible browser window for a takeover. Default: headed Chromium. Tests inject a headless one. */
  launchHeaded?: () => Promise<Browser>;
}

interface Pending {
  id: string;
  req: HumanAskRequest;
  resolve: (response: HumanResponse) => void;
  reject: (error: Error) => void;
  /** Starts (or restarts) the timeout; cleared while a human has the browser. */
  arm: () => void;
  disarm: () => void;
  stepIndex?: number;
}

interface Takeover {
  browser: Browser;
  page: Page;
  home: Page;
  lastUrl: string;
  /** Escalation that was waiting when the takeover started; answered with `resume` on release. */
  pending?: Pending;
  by: string;
}

/** The engine side of a human-in-the-loop run: one session per running case (job). */
export interface HumanSession {
  /** Engine hook for attended runs: waits for `approve` / `pickOther` / `skipStep` / `takeover` / `abort`. */
  hook: HumanHook;
  /** Awaited before every step; blocks while the run is paused or a human has the browser. */
  beforeStep: () => Promise<void>;
  /** Registers the case's page (for takeover); returns the function that unregisters it. */
  addPage: (page: Page) => () => void;
  /** True when a human asked not to save this case's explored path as a learned script. */
  readonly skipLearning: boolean;
  /** Ends the session: rejects open escalations and closes a takeover window. */
  close: () => void;
}

interface SessionState {
  runId: string;
  projectId: string;
  signal: AbortSignal;
  pending: Map<string, Pending>;
  page?: Page;
  skipLearning: boolean;
  closed: boolean;
}

interface RunState {
  sessions: Set<SessionState>;
  /** Reasons the run is held between steps: `pause` and `takeover`. */
  holds: Set<'pause' | 'takeover'>;
  waiters: Array<() => void>;
  takeover?: Takeover;
}

const topChoice = (probabilities: Record<string, number>): string | undefined =>
  Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];

/**
 * Human control of attended runs (S-037): holds escalations until a client answers them, pauses runs between
 * steps and hands the browser to a person. State is per run and lives in memory; messages arrive from the run
 * WebSocket or the `runs.control` mutation.
 */
export class HumanControl {
  private readonly runs = new Map<string, RunState>();

  constructor(private readonly opts: HumanControlOptions) {}

  /** Opens the engine side for one running case. Call `close()` when the case ends. */
  openSession(input: { runId: string; projectId: string; signal: AbortSignal }): HumanSession {
    const run = this.state(input.runId);
    const s: SessionState = { ...input, pending: new Map(), skipLearning: false, closed: false };
    run.sessions.add(s);

    const close = (): void => {
      if (s.closed) return;
      s.closed = true;
      for (const p of [...s.pending.values()]) {
        p.disarm();
        p.reject(new S1PilotError(HUMAN_UNAVAILABLE, 'Run ended before a human answered'));
      }
      s.pending.clear();
      run.sessions.delete(s);
      if (run.sessions.size === 0) {
        void this.closeTakeover(run);
        this.runs.delete(input.runId);
      }
      this.wake(run);
    };
    input.signal.addEventListener('abort', close, { once: true });

    return {
      hook: { ask: (req) => this.ask(s, run, req) },
      beforeStep: () => this.hold(s, run),
      addPage: (page) => {
        s.page = page;
        return () => {
          if (s.page === page) delete s.page;
        };
      },
      get skipLearning() {
        return s.skipLearning;
      },
      close,
    };
  }

  /** Escalations currently waiting for a human in a run (tests and diagnostics). */
  pendingEscalations(runId: string): string[] {
    const run = this.runs.get(runId);
    return run ? [...run.sessions].flatMap((s) => [...s.pending.keys()]) : [];
  }

  /**
   * Applies a control message to a run.
   * @throws S1PilotError `ESCALATION_NOT_FOUND`, `INVALID_CHOICE`, `INVALID_STATE`, `TAKEOVER_UNAVAILABLE`, `RUN_NOT_FOUND`.
   */
  async handle(runId: string, userId: string, msg: RunControlMessage): Promise<void> {
    const run = await repos.runs.get(this.opts.db, runId);
    if (!run) throw new S1PilotError('RUN_NOT_FOUND', `Run not found: ${runId}`, { runId });
    if (isTerminalRunStatus(run.status)) {
      throw new S1PilotError('INVALID_STATE', `Run already ${run.status}`, {
        runId,
        status: run.status,
      });
    }
    const by: Decided = { decidedBy: userId, via: 'live' };
    const state = this.runs.get(runId);
    switch (msg.type) {
      case 'approve':
      case 'pickOther': {
        const { session, pending } = this.find(state, msg.escalationId);
        if (!Object.hasOwn(pending.req.options, msg.choice)) {
          throw new S1PilotError('INVALID_CHOICE', `Unknown option "${msg.choice}"`, {
            options: Object.keys(pending.req.options),
          });
        }
        if (msg.type === 'approve' && !msg.saveToLearned) session.skipLearning = true;
        pending.resolve({
          choice: msg.choice,
          resolution: msg.type === 'approve' ? 'approved' : 'picked-other',
          ...by,
        });
        return;
      }
      case 'skipStep': {
        const pending = this.firstPending(state);
        if (!pending)
          throw new S1PilotError('ESCALATION_NOT_FOUND', 'No escalation is waiting for an answer');
        pending.resolve({ skip: true, ...by });
        return;
      }
      case 'abort': {
        const pending = state ? this.firstPending(state) : undefined;
        pending?.resolve({ abort: true, ...by });
        await this.opts.abortRun(runId);
        return;
      }
      case 'pause': {
        if (!state) throw new S1PilotError('INVALID_STATE', 'Run is not executing', { runId });
        if (state.holds.has('pause')) return;
        state.holds.add('pause');
        await this.setStatus(runId, 'paused');
        this.log(runId, 'Run paused: it stops before the next step');
        return;
      }
      case 'resume': {
        if (!state?.holds.has('pause')) return;
        state.holds.delete('pause');
        await this.setStatus(runId, 'running');
        this.log(runId, 'Run resumed');
        this.wake(state);
        return;
      }
      case 'takeover':
        await this.startTakeover(runId, state, userId);
        return;
      case 'release':
        await this.release(runId, state, by);
        return;
    }
  }

  private state(runId: string): RunState {
    let s = this.runs.get(runId);
    if (!s) this.runs.set(runId, (s = { sessions: new Set(), holds: new Set(), waiters: [] }));
    return s;
  }

  private firstPending(state: RunState | undefined): Pending | undefined {
    for (const s of state?.sessions ?? []) for (const p of s.pending.values()) return p;
    return undefined;
  }

  private find(
    state: RunState | undefined,
    id: string,
  ): { session: SessionState; pending: Pending } {
    for (const session of state?.sessions ?? []) {
      const pending = session.pending.get(id);
      if (pending) return { session, pending };
    }
    throw new S1PilotError('ESCALATION_NOT_FOUND', `No open escalation ${id}`, {
      escalationId: id,
    });
  }

  private log(runId: string, message: string): void {
    this.opts.bus.emit({
      type: 'log',
      runId,
      ts: new Date().toISOString(),
      level: 'info',
      message,
    });
  }

  private wake(run: RunState): void {
    if (run.holds.size > 0) return;
    for (const w of run.waiters.splice(0)) w();
  }

  private async setStatus(runId: string, status: 'paused' | 'running'): Promise<void> {
    await this.opts.lifecycle.lock(runId, async () => {
      const run = await repos.runs.get(this.opts.db, runId);
      // Only flip between the two live states; never resurrect a finished run.
      if (!run || (run.status !== 'running' && run.status !== 'paused')) return;
      if (run.status !== status) await repos.runs.update(this.opts.db, runId, { status });
    });
    this.opts.onStatus?.(runId, status);
  }

  private hold(s: SessionState, run: RunState): Promise<void> {
    if (run.holds.size === 0 || s.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        s.signal.removeEventListener('abort', done);
        resolve();
      };
      s.signal.addEventListener('abort', done, { once: true });
      run.waiters.push(done);
    });
  }

  private ask(s: SessionState, run: RunState, req: HumanAskRequest): Promise<HumanResponse> {
    const id = req.escalationId ?? newId();
    const timeoutMs = this.opts.config.escalationTimeoutMin * 60_000;
    return new Promise<HumanResponse>((resolve, reject) => {
      if (s.closed || s.signal.aborted) {
        reject(new S1PilotError(HUMAN_UNAVAILABLE, 'Run ended'));
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const disarm = (): void => {
        if (timer) clearTimeout(timer);
        timer = undefined;
      };
      const pending: Pending = {
        id,
        req,
        resolve: (response) => {
          disarm();
          s.pending.delete(id);
          this.afterDecision(s, id, req, response);
          resolve(response);
        },
        reject: (error) => {
          disarm();
          s.pending.delete(id);
          reject(error);
        },
        arm: () => {
          disarm();
          timer = setTimeout(() => {
            if (!s.pending.has(id)) return;
            this.opts.bus.emit({
              type: 'escalation.resolved',
              runId: s.runId,
              ts: new Date().toISOString(),
              escalationId: id,
              resolution: 'timed-out',
              by: 'human',
            });
            pending.reject(
              new S1PilotError(
                HUMAN_UNAVAILABLE,
                `No human answered within ${this.opts.config.escalationTimeoutMin} min`,
                { escalationId: id },
              ),
            );
          }, timeoutMs);
        },
        disarm,
      };
      s.pending.set(id, pending);
      // A takeover that started before this question appeared keeps the timer off until release.
      if (!run.takeover) pending.arm();
    });
  }

  /** Records the human decision for calibration when the model was not confident enough to act. */
  private afterDecision(
    s: SessionState,
    id: string,
    req: HumanAskRequest,
    response: HumanResponse,
  ): void {
    if (!('choice' in response)) return;
    const act = req.thresholds?.act;
    if (req.confidence === undefined || act === undefined || req.confidence >= act) return;
    const modelChoice = topChoice(req.probabilities);
    repos.reviews
      .create(this.opts.db, {
        id: newId(),
        projectId: s.projectId,
        kind: 'decision',
        refId: id,
        status: response.choice === modelChoice ? 'approved' : 'rejected',
        resolvedAt: new Date().toISOString(),
        note: JSON.stringify({
          runId: s.runId,
          question: req.question,
          modelChoice,
          humanChoice: response.choice,
          confidence: req.confidence,
          probabilities: req.probabilities,
          decidedBy: response.decidedBy,
          via: response.via,
        }),
      })
      .catch((error: unknown) =>
        this.opts.log.error(
          { err: error, escalationId: id },
          'could not record the human decision for review',
        ),
      );
  }

  private async startTakeover(
    runId: string,
    state: RunState | undefined,
    userId: string,
  ): Promise<void> {
    if (this.opts.config.mode !== 'local') {
      throw new S1PilotError(
        'TAKEOVER_UNAVAILABLE',
        'Taking over the browser is only available in local mode',
      );
    }
    if (!state) throw new S1PilotError('INVALID_STATE', 'Run is not executing', { runId });
    if (state.takeover)
      throw new S1PilotError('INVALID_STATE', 'The browser is already taken over', { runId });
    const home = [...state.sessions].find((x) => x.page && !x.page.isClosed())?.page;
    if (!home)
      throw new S1PilotError('INVALID_STATE', 'No browser page is open for this run yet', {
        runId,
      });

    state.holds.add('takeover');
    const pending = this.firstPending(state);
    pending?.disarm();
    try {
      const browser = await (
        this.opts.launchHeaded ?? (() => launchBrowser('chromium', { headed: true }))
      )();
      const context = await browser.newContext({
        storageState: await home.context().storageState(),
      });
      const page = await context.newPage();
      const url = home.url();
      await page.goto(url);
      const takeover: Takeover = {
        browser,
        page,
        home,
        lastUrl: url,
        by: userId,
        ...(pending ? { pending } : {}),
      };
      state.takeover = takeover;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) takeover.lastUrl = frame.url();
      });
      // The human closed the window instead of pressing release.
      browser.on('disconnected', () => {
        if (state.takeover === takeover)
          void this.release(runId, state, { decidedBy: userId, via: 'live' }, true).catch(
            () => undefined,
          );
      });
      await this.setStatus(runId, 'paused');
      this.log(runId, 'Browser taken over: the run is paused until released');
    } catch (error) {
      state.holds.delete('takeover');
      pending?.arm();
      this.wake(state);
      throw error instanceof S1PilotError
        ? error
        : new S1PilotError(
            'TAKEOVER_UNAVAILABLE',
            `Could not open a browser window: ${error instanceof Error ? error.message : String(error)}`,
          );
    }
  }

  private async release(
    runId: string,
    state: RunState | undefined,
    by: Decided,
    windowClosed = false,
  ): Promise<void> {
    const takeover = state?.takeover;
    if (!state || !takeover)
      throw new S1PilotError('INVALID_STATE', 'The browser is not taken over', { runId });
    delete state.takeover;
    let url = takeover.lastUrl;
    try {
      if (!windowClosed) {
        const storage = await takeover.page.context().storageState();
        url = takeover.page.url();
        await takeover.home.context().addCookies(storage.cookies);
        const origin = (() => {
          try {
            return new URL(url).origin;
          } catch {
            return '';
          }
        })();
        const local = storage.origins.find((o) => o.origin === origin)?.localStorage ?? [];
        if (local.length > 0 && !takeover.home.isClosed()) {
          await takeover.home.goto(origin, { waitUntil: 'commit' }).catch(() => undefined);
          await takeover.home.evaluate((items) => {
            // Runs in the page; the server's TS config has no DOM lib.
            const storage = (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage;
            for (const i of items) storage.setItem(i.name, i.value);
          }, local);
        }
      }
    } catch (error) {
      this.opts.log.warn({ err: error, runId }, 'takeover: could not carry the browser state back');
    }
    await takeover.browser.close().catch(() => undefined);
    // Land on whatever the human left open, so the next observation shows the current state.
    if (!takeover.home.isClosed()) await takeover.home.goto(url).catch(() => undefined);
    state.holds.delete('takeover');
    if (!state.holds.has('pause')) await this.setStatus(runId, 'running');
    this.log(runId, 'Browser released: the run continues with a fresh observation');
    for (const session of state.sessions)
      for (const p of session.pending.values()) if (p !== takeover.pending) p.arm();
    takeover.pending?.resolve({ takeover: true, resume: true, ...by });
    this.wake(state);
  }

  private async closeTakeover(run: RunState): Promise<void> {
    const takeover = run.takeover;
    delete run.takeover;
    await takeover?.browser.close().catch(() => undefined);
  }
}
