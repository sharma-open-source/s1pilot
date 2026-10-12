import { S1PilotError, type Calibrator, type ModelSettings, type Redactor } from '@s1pilot/domain';
import { createChatModel, createDecisionModel } from '@s1pilot/providers';
import type { RunnerModels } from '@s1pilot/runner';

/** Builds the models of a run from the effective model settings. Tests inject their own (mock) factory. */
export type ModelFactory = (settings: ModelSettings, redactor: Redactor, calibrator?: Calibrator) => RunnerModels;

function resolveKey(ref: string | undefined, env: NodeJS.ProcessEnv, fallbackVar: string): string | undefined {
  if (ref?.startsWith('env:')) {
    const value = env[ref.slice('env:'.length)];
    if (!value) throw new S1PilotError('MISSING_ENV_VAR', `Environment variable ${ref.slice('env:'.length)} (model apiKeyRef) is not set`);
    return value;
  }
  return env[fallbackVar];
}

/** Host of an endpoint URL, or undefined when it does not parse. */
function hostOf(url: string | undefined): string | undefined {
  try {
    return url === undefined ? undefined : new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * API keys of System 1 and System 2 from the settings, read from the environment (never from the database):
 * an `env:NAME` reference, else `S1PILOT_API_KEY` / `S1PILOT_S2_API_KEY`. A System 2 on the same host as
 * System 1 (one OpenRouter account for both, say) without a key of its own uses the System 1 key.
 * Throws `MISSING_ENV_VAR` when a referenced variable is not set.
 */
export function modelKeys(settings: ModelSettings, env: NodeJS.ProcessEnv = process.env): { s1?: string; s2?: string } {
  const s1 = resolveKey(settings.system1.apiKeyRef, env, 'S1PILOT_API_KEY');
  if (!settings.system2) return s1 ? { s1 } : {};
  const own = resolveKey(settings.system2.apiKeyRef, env, 'S1PILOT_S2_API_KEY');
  const sameHost = hostOf(settings.system2.baseUrl) !== undefined && hostOf(settings.system2.baseUrl) === hostOf(settings.system1.baseUrl);
  const s2 = own ?? (sameHost ? s1 : undefined);
  return { ...(s1 ? { s1 } : {}), ...(s2 ? { s2 } : {}) };
}

/** Says where the server gets the System 2 key from, for "key rejected" errors. Never includes the key. */
export function system2KeySource(settings: ModelSettings): string {
  const ref = settings.system2?.apiKeyRef;
  if (ref?.startsWith('env:')) return `The server reads it from the environment variable ${ref.slice('env:'.length)}; check that it holds a valid key and restart the server after changing it.`;
  const sameHost = hostOf(settings.system2?.baseUrl) !== undefined && hostOf(settings.system2?.baseUrl) === hostOf(settings.system1.baseUrl);
  return `No key reference is saved for System 2 (a pasted key is only used for Test connection), so the server uses S1PILOT_S2_API_KEY${sameHost ? ' or, when that is unset, the System 1 key' : ''}. Enter env:NAME in the System 2 API key field and set that variable on the server.`;
}

/**
 * Default {@link ModelFactory}: System 1 (and optional System 2) from the settings; API keys come from
 * `env:NAME` references (falling back to `S1PILOT_API_KEY` / `S1PILOT_S2_API_KEY`), never from the database.
 */
export function createModelFactory(env: NodeJS.ProcessEnv = process.env): ModelFactory {
  return (settings, redactor, calibrator) => {
    const keys = modelKeys(settings, env);
    const s1 = createDecisionModel(settings.system1, { ...(keys.s1 ? { apiKey: keys.s1 } : {}), redactor, ...(calibrator ? { calibrator } : {}) });
    const s2 = settings.system2 ? createChatModel(settings.system2, { ...(keys.s2 ? { apiKey: keys.s2 } : {}), redactor }) : undefined;
    return { s1, ...(s2 ? { s2 } : {}), thresholds: settings.thresholds, modelName: settings.system1.model };
  };
}
