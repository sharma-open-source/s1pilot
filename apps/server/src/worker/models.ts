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

/**
 * Default {@link ModelFactory}: System 1 (and optional System 2) from the settings; API keys come from
 * `env:NAME` references (falling back to `S1PILOT_API_KEY` / `S1PILOT_S2_API_KEY`), never from the database.
 */
export function createModelFactory(env: NodeJS.ProcessEnv = process.env): ModelFactory {
  return (settings, redactor, calibrator) => {
    const key1 = resolveKey(settings.system1.apiKeyRef, env, 'S1PILOT_API_KEY');
    const s1 = createDecisionModel(settings.system1, { ...(key1 ? { apiKey: key1 } : {}), redactor, ...(calibrator ? { calibrator } : {}) });
    let s2;
    if (settings.system2) {
      const key2 = resolveKey(settings.system2.apiKeyRef, env, 'S1PILOT_S2_API_KEY');
      s2 = createChatModel(settings.system2, { ...(key2 ? { apiKey: key2 } : {}), redactor });
    }
    return { s1, ...(s2 ? { s2 } : {}), thresholds: settings.thresholds, modelName: settings.system1.model };
  };
}
