import {
  S1PilotError,
  type AuthSetup,
  type AuthValidation,
  type BrowserName,
  type Environment,
  type Redactor,
  type SharedStep,
  type TestCase,
} from '@s1pilot/domain';
import { flowReference } from '@s1pilot/engine';
import type { Browser, BrowserContext } from 'playwright';

import { launchBrowser, runCases, type AuthStateProvider, type RunnerModels, type RunnerVars } from './run-cases.js';

/** Playwright storage state (cookies + local storage). A secret: never log, export or write it unencrypted. */
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Outcome of {@link validateAuthState}. */
export interface AuthCheck {
  ok: boolean;
  /** Why the check failed (no page content, no secrets). */
  reason?: string;
}

const absolute = (environment: Pick<Environment, 'baseUrl'>, url: string): string => new URL(url, environment.baseUrl.endsWith('/') ? environment.baseUrl : `${environment.baseUrl}/`).toString();

/**
 * Opens `validation.url` in a fresh context that carries `state` and runs the assertion.
 * Any failure (including navigation errors) yields `{ ok: false }`; this never throws for a bad login.
 */
export async function validateAuthState(
  browser: Browser,
  environment: Pick<Environment, 'baseUrl' | 'locale' | 'timezone'>,
  state: StorageState,
  validation: AuthValidation,
): Promise<AuthCheck> {
  const context = await browser.newContext({ storageState: state, locale: environment.locale, timezoneId: environment.timezone });
  try {
    const page = await context.newPage();
    const response = await page.goto(absolute(environment, validation.url), { waitUntil: 'domcontentloaded', timeout: 15_000 });
    if (response && response.status() >= 400) return { ok: false, reason: `validation page answered HTTP ${response.status()}` };
    const { kind, value } = validation.assertion;
    if (kind === 'url-contains') {
      return page.url().includes(value) ? { ok: true } : { ok: false, reason: `url does not contain "${value}"` };
    }
    const text = await page.locator('body').innerText({ timeout: 5000 });
    const present = text.includes(value);
    if (kind === 'text-visible') return present ? { ok: true } : { ok: false, reason: `text "${value}" not found` };
    return present ? { ok: false, reason: `text "${value}" is present` } : { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.split('\n')[0] ?? 'validation failed' : 'validation failed' };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** Persistence of auth setups (the server backs it with the encrypted `auth_setups` table). */
export interface AuthSetupStore {
  find(environment: Environment, name: string): Promise<AuthSetup | undefined>;
  /** Decrypted storage state, if one is stored. */
  loadState(setup: AuthSetup): Promise<StorageState | undefined>;
  /** Persists a fresh state and marks the setup `valid`. */
  saveState(setup: AuthSetup, state: StorageState): Promise<void>;
  markExpired(setup: AuthSetup): Promise<void>;
}

/** Produces a fresh storage state for a setup (runs the login flow); throws on failure. */
export type AuthRefresher = (setup: AuthSetup, environment: Environment) => Promise<StorageState>;

/**
 * Refreshes `setup` once: runs `refresh`, validates the result (when the setup has a validation) and saves it.
 * Throws `AUTH_REFRESH_FAILED` when the new state does not validate.
 */
export async function refreshAuthSetup(opts: {
  browser: Browser;
  store: AuthSetupStore;
  refresh: AuthRefresher;
  setup: AuthSetup;
  environment: Environment;
}): Promise<StorageState> {
  const { browser, store, refresh, setup, environment } = opts;
  const state = await refresh(setup, environment);
  if (setup.validation) {
    const check = await validateAuthState(browser, environment, state, setup.validation);
    if (!check.ok) {
      await store.markExpired(setup);
      throw new S1PilotError('AUTH_REFRESH_FAILED', `Login "${setup.name}" was refreshed but is not valid: ${check.reason ?? 'validation failed'}`, { name: setup.name });
    }
  }
  await store.saveState(setup, state);
  return state;
}

/** Name of the first `auth:` precondition of a case. */
export function authNameOf(testCase: Pick<TestCase, 'preconditions'>): string | undefined {
  for (const pre of testCase.preconditions) if ('auth' in pre) return pre.auth;
  return undefined;
}

/**
 * {@link AuthStateProvider} for `runCases`: loads the saved state of the case's `auth:` precondition, validates it, and
 * when it is missing or expired refreshes it **once** (concurrent cases share the attempt; a failed refresh is not
 * retried by later cases of the same provider). Failures throw `AUTH_*` errors, which `runCases` turns into a `blocked` case.
 */
export function createAuthStateProvider(opts: { browser: Browser; store: AuthSetupStore; refresh?: AuthRefresher }): AuthStateProvider {
  const attempts = new Map<string, Promise<StorageState>>();

  const resolve = async (setup: AuthSetup, environment: Environment): Promise<StorageState> => {
    const stored = await opts.store.loadState(setup);
    if (stored) {
      if (!setup.validation) return stored;
      const check = await validateAuthState(opts.browser, environment, stored, setup.validation);
      if (check.ok) return stored;
      await opts.store.markExpired(setup);
    }
    if (setup.kind !== 'flow' || !opts.refresh) {
      throw new S1PilotError(
        'AUTH_EXPIRED',
        stored ? `Login "${setup.name}" has expired; record it again` : `Login "${setup.name}" has no saved state; record it first`,
        { name: setup.name },
      );
    }
    return refreshAuthSetup({ browser: opts.browser, store: opts.store, refresh: opts.refresh, setup, environment });
  };

  return {
    async storageState(testCase, environment) {
      const name = authNameOf(testCase);
      if (name === undefined) return undefined;
      const setup = await opts.store.find(environment, name);
      if (!setup) throw new S1PilotError('AUTH_NOT_FOUND', `Auth setup "${name}" not found for environment ${environment.name}`, { name });
      let attempt = attempts.get(setup.id);
      if (!attempt) {
        attempt = resolve(setup, environment);
        attempts.set(setup.id, attempt);
      }
      return attempt;
    },
  };
}

/** Everything a login flow needs to run through the engine. */
export interface FlowRefresherOptions {
  browser: Browser;
  browserName?: BrowserName;
  models: RunnerModels;
  vars: RunnerVars;
  redactor: Redactor;
  /** Finds the shared step named by `setup.flowId`. */
  flows: (idOrName: string) => SharedStep | undefined;
  /** Scratch directory for the run output (trace of the login; contains no storage state). */
  out: string;
}

/**
 * {@link AuthRefresher} for `kind: 'flow'`: runs the shared step with the engine in a fresh context and captures the
 * resulting storage state just before that context closes.
 */
export function createFlowRefresher(opts: FlowRefresherOptions): AuthRefresher {
  return async (setup, environment) => {
    if (!setup.flowId) throw new S1PilotError('AUTH_FLOW_MISSING', `Auth setup "${setup.name}" has no flow`, { name: setup.name });
    if (!opts.flows(setup.flowId)) throw new S1PilotError('FLOW_NOT_FOUND', `Shared step / flow "${setup.flowId}" not found`, { flow: setup.flowId });
    let captured: StorageState | undefined;
    const testCase: TestCase = {
      id: setup.id,
      projectId: environment.projectId,
      version: 1,
      key: `AUTH-${setup.name}`,
      title: `Log in: ${setup.name}`,
      priority: 'P2',
      type: 'smoke',
      status: 'ready',
      tags: [],
      requirements: [],
      preconditions: [],
      parameters: [],
      steps: [flowReference(setup.flowId)],
    };
    const report = await runCases({
      cases: [testCase],
      environment,
      browser: opts.browser,
      browserName: opts.browserName ?? 'chromium',
      mode: 'explore',
      models: opts.models,
      out: opts.out,
      vars: opts.vars,
      redactor: opts.redactor,
      flows: opts.flows,
      capture: { screenshots: false, trace: false, logs: false, video: false },
      onPage: (page) => () => {
        // Awaited by the runner before the context closes.
        return page
          .context()
          .storageState()
          .then((s) => void (captured = s));
      },
    });
    const result = report.cases[0];
    if (!result || result.verdict !== 'passed' || !captured) {
      const failed = result?.steps.find((s) => s.verdict !== 'passed' && s.verdict !== 'skipped');
      throw new S1PilotError('AUTH_REFRESH_FAILED', `Login flow "${setup.name}" did not complete${failed?.reason ? `: ${failed.reason}` : ''}`, { name: setup.name });
    }
    return captured;
  };
}

/** A headed browser the user logs in with; {@link LoginRecording.finish} returns the resulting state. */
export interface LoginRecording {
  /** The login page, for tests and live views. */
  page: import('playwright').Page;
  /** Captures the storage state and closes the browser. */
  finish(): Promise<StorageState>;
  /** Closes the browser without saving. */
  cancel(): Promise<void>;
}

/** Opens `environment.baseUrl` in a (by default headed) browser for the user to log in. */
export async function startLoginRecording(
  environment: Pick<Environment, 'baseUrl' | 'locale' | 'timezone'>,
  opts: { launch?: () => Promise<Browser> } = {},
): Promise<LoginRecording> {
  const browser = await (opts.launch ?? (() => launchBrowser('chromium', { headed: true })))();
  try {
    const context = await browser.newContext({ locale: environment.locale, timezoneId: environment.timezone });
    const page = await context.newPage();
    await page.goto(environment.baseUrl);
    return {
      page,
      finish: async () => {
        try {
          return await context.storageState();
        } finally {
          await browser.close().catch(() => undefined);
        }
      },
      cancel: () => browser.close().catch(() => undefined),
    };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}
