import { repos, type Db } from '@s1pilot/db';
import {
  ModelSettingsSchema,
  S1PilotError,
  createRedactor,
  newId,
  type Environment,
  type Project,
  type Step,
  type TestCase,
} from '@s1pilot/domain';
import type { ChatModel } from '@s1pilot/providers';
import {
  insertResolved,
  launchBrowser,
  recordedScript,
  recordedToResolved,
  startRecorder,
  type RecorderHandle,
  type RecorderSnapshot,
  type RecordingDraft,
} from '@s1pilot/runner';

import type { ServerConfig } from '../config.js';
import { WORKSPACE_MODEL_KEY } from '../trpc/routers/helpers.js';
import { createModelFactory, type ModelFactory } from '../worker/models.js';

type Browser = Awaited<ReturnType<typeof launchBrowser>>;

export interface RecorderServiceOptions {
  db: Db;
  config: ServerConfig;
  /** Visible browser to record in. Default: headed Chromium. Tests inject a headless one. */
  launchHeaded?: () => Promise<Browser>;
  /** Builds System 2 for step text. Default: {@link createModelFactory}. */
  createModels?: ModelFactory;
}

/** Input of {@link RecorderService.start}. */
export interface StartRecordingInput {
  project: Project;
  environment: Environment;
  /** Append to (or insert into) this case; without it a new draft case is created on save. */
  testCase?: TestCase;
  /** Index at which recorded steps are inserted into `testCase` (default: the end). */
  fromStep?: number;
  /** Suite of the new draft case. */
  suiteId?: string;
}

/** One step as edited in the review dialog. `id` refers to a step of the draft; steps without one carry no recorded actions. */
export interface SaveStepInput {
  id?: string | undefined;
  action: string;
  expected?: string | undefined;
}

/** Input of {@link RecorderService.save}. */
export interface SaveRecordingInput {
  steps: SaveStepInput[];
  /** Values for proposed variables, by key (required for secrets, optional overrides for the rest). */
  variables?: Record<string, string> | undefined;
  /** Title of the new case (ignored when appending to an existing one). */
  title?: string | undefined;
}

/** Result of {@link RecorderService.save}. */
export interface SaveRecordingResult {
  testCase: TestCase;
  /** True when a learned script was stored for the environment. */
  learned: boolean;
  createdVariables: string[];
  /** Secret variables the recording uses that still need a value (Settings, Environments). */
  missingSecrets: string[];
}

/** State of a recording for the UI. */
export interface RecordingStatus extends RecorderSnapshot {
  sessionId: string;
  caseKey?: string;
  fromStep: number;
  /** True once the user pressed Stop in the browser toolbar (or closed the window). */
  stoppedFromBrowser: boolean;
  /** Present once stopped. */
  draft?: RecordingDraft;
}

interface Session {
  id: string;
  input: StartRecordingInput;
  fromStep: number;
  handle: RecorderHandle;
  draft?: RecordingDraft;
  stoppedFromBrowser: boolean;
}

const CONFIGURED = (value: string | undefined): value is string => value !== undefined && value !== '';

/**
 * Recorder (S-060): opens a headed browser on the machine running the server (local mode), captures what
 * the user does, and on save appends the steps to a case together with a learned script for the environment.
 */
export class RecorderService {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly opts: RecorderServiceOptions) {}

  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new S1PilotError('RECORDING_NOT_FOUND', `No recording with id ${id}`, { id });
    return s;
  }

  /** System 2 for step text, if one is configured; any problem means "no S2". */
  private async chatFor(project: Project): Promise<ChatModel | undefined> {
    try {
      const workspace = ModelSettingsSchema.safeParse(await repos.settings.get(this.opts.db, WORKSPACE_MODEL_KEY));
      const settings = project.modelSettings ?? (workspace.success ? workspace.data : undefined);
      if (!settings?.system2) return undefined;
      const redactor = createRedactor({ secrets: [], patterns: project.dataPolicy.redactPatterns });
      return (this.opts.createModels ?? createModelFactory())(settings, redactor).s2;
    } catch {
      return undefined;
    }
  }

  /** Opens the browser and starts capturing. Local mode only: the window opens where the server runs. */
  async start(input: StartRecordingInput): Promise<RecordingStatus> {
    if (this.opts.config.mode !== 'local') {
      throw new S1PilotError('RECORDER_UNAVAILABLE', 'Recording opens a browser window and is only available in local mode');
    }
    const { environment, testCase } = input;
    const fromStep = testCase ? Math.min(Math.max(input.fromStep ?? testCase.steps.length, 0), testCase.steps.length) : 0;
    const id = newId();
    const known = {
      vars: Object.fromEntries(
        environment.variables.flatMap((v) => (!v.secret && v.source === 'inline' && CONFIGURED(v.value) ? [[v.key, v.value] as const] : [])),
      ),
      secretKeys: environment.variables.filter((v) => v.secret).map((v) => v.key),
    };
    const chat = await this.chatFor(input.project);
    const session: Session = { id, input, fromStep, handle: undefined as unknown as RecorderHandle, stoppedFromBrowser: false };
    session.handle = await startRecorder({
      environment,
      known,
      // Recording into the middle of a case: the user first navigates to the right page, then resumes.
      startPaused: fromStep > 0,
      ...(chat ? { chat } : {}),
      ...(this.opts.launchHeaded ? { launch: this.opts.launchHeaded } : {}),
      onStopped: (draft) => {
        session.draft = draft;
        session.stoppedFromBrowser = true;
      },
    });
    this.sessions.set(id, session);
    return this.status(id);
  }

  /** Live state: captured steps while recording, the draft once stopped. */
  status(id: string): RecordingStatus {
    const s = this.get(id);
    const snap = s.handle.snapshot();
    return {
      ...snap,
      sessionId: s.id,
      ...(s.input.testCase ? { caseKey: s.input.testCase.key } : {}),
      fromStep: s.fromStep,
      stoppedFromBrowser: s.stoppedFromBrowser,
      ...(s.draft ? { draft: s.draft } : {}),
    };
  }

  pause(id: string): RecordingStatus {
    this.get(id).handle.pause();
    return this.status(id);
  }

  resume(id: string): RecordingStatus {
    this.get(id).handle.resume();
    return this.status(id);
  }

  /** "Add expected result" from the UI panel. */
  addExpectation(id: string, text: string): RecordingStatus {
    this.get(id).handle.addExpectation(text);
    return this.status(id);
  }

  /** The recorded page (tests drive it; users use the real window). */
  page(id: string) {
    return this.get(id).handle.page;
  }

  /** Stops recording and returns the draft for review. Safe to call after the toolbar's Stop. */
  async stop(id: string): Promise<RecordingStatus> {
    const s = this.get(id);
    s.draft ??= await s.handle.stop();
    return this.status(id);
  }

  /** Drops the recording and closes its browser. */
  async cancel(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    await s?.handle.cancel();
  }

  /**
   * Saves the reviewed recording: creates the needed variables, appends the steps to the case (or creates a
   * draft case) and stores the learned script for the environment, hashed against the final step texts.
   */
  async save(id: string, input: SaveRecordingInput): Promise<SaveRecordingResult> {
    const s = this.get(id);
    if (!s.draft) throw new S1PilotError('INVALID_STATE', 'Stop the recording before saving it');
    if (input.steps.length === 0) throw new S1PilotError('INVALID_INPUT', 'A recording needs at least one step');
    const { db } = this.opts;
    const draft = s.draft;
    const { project, environment, testCase } = s.input;
    const byId = new Map(draft.steps.map((d) => [d.id, d]));

    const reviewed = input.steps.map((step) => {
      const d = step.id ? byId.get(step.id) : undefined;
      const action = step.action.trim();
      if (!action) throw new S1PilotError('INVALID_INPUT', 'A step needs text');
      const expected = step.expected?.trim();
      return { action, ...(expected ? { expected } : {}), inputs: d?.inputs ?? [], actions: d?.actions ?? [] };
    });

    // Variables the kept steps actually use.
    const used = new Set(reviewed.flatMap((r) => r.actions.flatMap((a) => (a.valueRef ? [a.valueRef.slice(a.valueRef.indexOf(':') + 1)] : []))));
    const createdVariables: string[] = [];
    const missingSecrets: string[] = [];
    const existing = await repos.environments.get(db, environment.id);
    const variables = [...(existing?.variables ?? environment.variables)];
    for (const p of draft.variables) {
      if (!used.has(p.key) || variables.some((v) => v.key === p.key)) continue;
      const value = input.variables?.[p.key] ?? p.value;
      if (p.secret) {
        if (!CONFIGURED(value)) {
          missingSecrets.push(p.key);
          continue;
        }
        variables.push({ key: p.key, value, secret: true, source: 'inline' });
      } else {
        if (value === undefined) continue;
        variables.push({ key: p.key, value, secret: false, source: 'inline' });
      }
      createdVariables.push(p.key);
    }
    if (createdVariables.length > 0) await repos.environments.update(db, environment.id, { variables });

    const newSteps: Step[] = reviewed.map((r) => ({ action: r.action, ...(r.expected ? { expected: r.expected } : {}), assert: [], inputs: r.inputs }));
    let saved: TestCase;
    let at = 0;
    if (testCase) {
      at = s.fromStep;
      const current = await repos.cases.get(db, testCase.id);
      if (!current) throw new S1PilotError('CASE_NOT_FOUND', `Case not found: ${testCase.key}`, { key: testCase.key });
      const steps = [...current.steps.slice(0, at), ...newSteps, ...current.steps.slice(at)];
      saved = await repos.cases.update(db, current.id, { steps }, { expectedVersion: current.version });
    } else {
      saved = await repos.cases.create(db, project.id, {
        title: input.title?.trim() || `Recorded test ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        priority: 'P2',
        type: 'e2e',
        status: 'draft',
        tags: ['recorded'],
        requirements: [],
        preconditions: [],
        parameters: [],
        steps: newSteps,
        ...(s.input.suiteId ? { suiteId: s.input.suiteId } : {}),
      });
    }

    // Learned script: recorded actions, merged into the existing script of this environment when there is one.
    const runId = newId();
    const recorded = recordedToResolved(reviewed, runId);
    const old = testCase ? await repos.learnedScripts.getFor(db, saved.id, environment.id) : undefined;
    const actions = insertResolved(old?.actions ?? [], recorded, at, newSteps.length);
    let learned = false;
    if (actions.length > 0) {
      await repos.learnedScripts.upsert(db, {
        ...recordedScript({ caseId: saved.id, caseVersion: saved.version, environmentId: environment.id, actions, runId }),
        ...(old ? { health: old.health } : {}),
      });
      learned = true;
    }

    this.sessions.delete(id);
    return { testCase: saved, learned, createdVariables, missingSecrets };
  }

  /** Closes every open recording window. */
  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.cancel(id)));
  }
}
