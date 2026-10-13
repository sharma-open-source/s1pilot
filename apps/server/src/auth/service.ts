import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { repos, resolveVariables, type Db } from '@s1pilot/db';
import {
  ModelSettingsSchema,
  S1PilotError,
  createRedactor,
  newId,
  type AuthSetup,
  type AuthValidation,
  type Environment,
  type Redactor,
  type SharedStep,
} from '@s1pilot/domain';
import {
  createAuthStateProvider,
  createFlowRefresher,
  launchBrowser,
  refreshAuthSetup,
  startLoginRecording,
  validateAuthState,
  type AuthRefresher,
  type AuthSetupStore,
  type LoginRecording,
  type RunnerModels,
  type RunnerVars,
  type StorageState,
} from '@s1pilot/runner';

import type { ServerConfig } from '../config.js';
import { WORKSPACE_MODEL_KEY } from '../trpc/routers/helpers.js';
import { loadModelSecrets } from '../worker/model-secrets.js';
import { createModelFactory, type ModelFactory } from '../worker/models.js';

type Browser = Awaited<ReturnType<typeof launchBrowser>>;

export interface AuthServiceOptions {
  db: Db;
  config: ServerConfig;
  /** Headless browser for validation and flow refreshes. Default: Chromium via {@link launchBrowser}. */
  launch?: (name: 'chromium' | 'firefox' | 'webkit') => Promise<Browser>;
  /** Visible browser for recording a login. Default: headed Chromium. Tests inject a headless one. */
  launchHeaded?: () => Promise<Browser>;
  /** Builds System 1/2 for login flows. Default: {@link createModelFactory}. */
  createModels?: ModelFactory;
}

/** Everything a run (or a manual refresh) needs to refresh a flow login. */
export interface FlowRefreshContext {
  browser: Browser;
  environment: Environment;
  models: RunnerModels;
  vars: RunnerVars;
  redactor: Redactor;
  flows: (idOrName: string) => SharedStep | undefined;
  out: string;
}

/**
 * Auth setups (S-038): database-backed store (storage states encrypted by the vault), the provider handed to
 * `runCases`, manual refresh / validate, and the headed login recordings.
 */
export class AuthService {
  private readonly recordings = new Map<string, LoginRecording>();

  constructor(private readonly opts: AuthServiceOptions) {}

  /** Database-backed {@link AuthSetupStore}; states are decrypted only when handed to the runner. */
  readonly store: AuthSetupStore = {
    find: (environment, name) => repos.authSetups.getByName(this.opts.db, environment.id, name),
    loadState: async (setup) => {
      const json = await repos.authSetups.getState(this.opts.db, setup.id);
      return json ? (JSON.parse(json) as StorageState) : undefined;
    },
    saveState: async (setup, state) => {
      await repos.authSetups.saveState(this.opts.db, setup.id, JSON.stringify(state));
    },
    markExpired: (setup) => repos.authSetups.setStatus(this.opts.db, setup.id, 'expired'),
  };

  /** Loads variables, models and flows of an environment's project for a login-flow refresh. */
  async flowContext(environment: Environment, browser: Browser, out: string): Promise<FlowRefreshContext> {
    const { db } = this.opts;
    const project = await repos.projects.get(db, environment.projectId);
    if (!project) throw new S1PilotError('PROJECT_NOT_FOUND', `Project not found: ${environment.projectId}`);
    const workspace = ModelSettingsSchema.safeParse(await repos.settings.get(db, WORKSPACE_MODEL_KEY));
    const settings = project.modelSettings ?? (workspace.success ? workspace.data : undefined);
    if (!settings) throw new S1PilotError('MODEL_NOT_CONFIGURED', 'No System 1 model is configured (Settings → Models).');
    const vars = resolveVariables(environment, {
      vault: db.crypto,
      ciphertexts: await repos.environments.secretCiphertexts(db, environment.id),
    });
    const redactor = createRedactor({ secrets: vars.secretValues(), patterns: project.dataPolicy.redactPatterns });
    const models = (this.opts.createModels ?? createModelFactory())(settings, redactor, undefined, await loadModelSecrets(db, settings));
    const flows = await repos.sharedSteps.listByProject(db, project.id);
    const flowMap = new Map<string, SharedStep>(flows.flatMap((f) => [[f.id, f] as const, [f.name, f] as const]));
    return { browser, environment, models, vars, redactor, flows: (k) => flowMap.get(k), out };
  }

  /** Provider for `runCases`: restores the case's login, refreshing a flow login once when it expired. */
  providerFor(browser: Browser, refresh: AuthRefresher | undefined) {
    return createAuthStateProvider({ browser, store: this.store, ...(refresh ? { refresh } : {}) });
  }

  /** Lazy refresher: models / variables / flows are only loaded when a flow login really needs refreshing. */
  lazyRefresher(browser: Browser, workDir: string): AuthRefresher {
    return async (setup, environment) => {
      const ctx = await this.flowContext(environment, browser, join(workDir, 'auth', newId()));
      try {
        return await createFlowRefresher(ctx)(setup, environment);
      } finally {
        await rm(ctx.out, { recursive: true, force: true }).catch(() => undefined);
      }
    };
  }

  private async withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
    const browser = await (this.opts.launch ?? ((name) => launchBrowser(name)))('chromium');
    try {
      return await fn(browser);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async load(setupId: string): Promise<{ setup: AuthSetup; environment: Environment }> {
    const setup = await repos.authSetups.get(this.opts.db, setupId);
    if (!setup) throw new S1PilotError('AUTH_NOT_FOUND', `Auth setup not found: ${setupId}`, { id: setupId });
    const environment = await repos.environments.get(this.opts.db, setup.environmentId);
    if (!environment) throw new S1PilotError('ENVIRONMENT_NOT_FOUND', `Environment not found: ${setup.environmentId}`);
    return { setup, environment };
  }

  /** Re-runs the login flow of a `flow` setup and stores the new state (validated when the setup has a validation). */
  async refresh(setupId: string): Promise<AuthSetup> {
    const { setup, environment } = await this.load(setupId);
    if (setup.kind !== 'flow') {
      throw new S1PilotError('INVALID_STATE', 'Only flow logins can be refreshed; record a recorded login again');
    }
    await this.withBrowser((browser) =>
      refreshAuthSetup({
        browser,
        store: this.store,
        refresh: this.lazyRefresher(browser, this.opts.config.artifactsDir),
        setup,
        environment,
      }),
    );
    return (await repos.authSetups.get(this.opts.db, setupId)) as AuthSetup;
  }

  /** Opens the validation URL with the stored state and updates the setup's status. */
  async validate(setupId: string): Promise<{ setup: AuthSetup; ok: boolean; reason?: string }> {
    const { setup, environment } = await this.load(setupId);
    const state = await this.store.loadState(setup);
    if (!state) return { setup, ok: false, reason: 'no saved state' };
    let check: { ok: boolean; reason?: string } = { ok: true };
    if (setup.validation) {
      const validation: AuthValidation = setup.validation;
      check = await this.withBrowser((browser) => validateAuthState(browser, environment, state, validation));
    }
    await repos.authSetups.setStatus(this.opts.db, setupId, check.ok ? 'valid' : 'expired');
    const updated = (await repos.authSetups.get(this.opts.db, setupId)) as AuthSetup;
    return { setup: updated, ok: check.ok, ...(check.reason ? { reason: check.reason } : {}) };
  }

  /** Opens a headed browser at the environment's base URL; one recording per setup at a time. */
  async startRecording(setup: AuthSetup, environment: Environment): Promise<void> {
    if (this.recordings.has(setup.id)) {
      throw new S1PilotError('CONFLICT', `A login recording for "${setup.name}" is already open`, { name: setup.name });
    }
    const recording = await startLoginRecording(environment, this.opts.launchHeaded ? { launch: this.opts.launchHeaded } : {});
    this.recordings.set(setup.id, recording);
  }

  /** The open recording's page (tests drive it; the UI shows the real window). */
  recordingPage(setupId: string) {
    return this.recordings.get(setupId)?.page;
  }

  /** Captures the state of the open recording, stores it encrypted and closes the browser. */
  async finishRecording(setupId: string): Promise<AuthSetup> {
    const recording = this.recordings.get(setupId);
    if (!recording) throw new S1PilotError('INVALID_STATE', 'No login recording is open for this setup');
    this.recordings.delete(setupId);
    const state = await recording.finish();
    await this.store.saveState({ id: setupId } as AuthSetup, state);
    return (await repos.authSetups.get(this.opts.db, setupId)) as AuthSetup;
  }

  async cancelRecording(setupId: string): Promise<void> {
    const recording = this.recordings.get(setupId);
    this.recordings.delete(setupId);
    await recording?.cancel();
  }

  /** Closes any open recording windows. */
  async close(): Promise<void> {
    await Promise.all([...this.recordings.keys()].map((id) => this.cancelRecording(id)));
  }
}
