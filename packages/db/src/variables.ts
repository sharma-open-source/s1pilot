import { S1PilotError, type Environment } from '@s1pilot/domain';

import type { Vault } from './vault.js';

/** Variables of one environment, resolved for a run. Secret values exist only in memory here. */
export interface ResolvedVars {
  get(key: string): string | undefined;
  isSecret(key: string): boolean;
  keys(): string[];
  /** Safe to log or send to a model: secrets appear as `«secret:key»`. */
  publicView(): Record<string, string>;
  /** Plaintext secret values, for building a `Redactor`. Never log these. */
  secretValues(): string[];
}

export interface ResolveOptions {
  vault: Vault;
  /** Source for `source: 'env'` variables. Default: `process.env`. */
  processEnv?: NodeJS.ProcessEnv;
  /** Encrypted values of inline secret variables by key (see `repos.environments.secretCiphertexts`). */
  ciphertexts?: Record<string, string>;
}

/**
 * Resolves an environment's variables: inline values, `process.env` lookups and decrypted secrets.
 * Errors name the variable key, never a value.
 */
export function resolveVariables(
  env: Pick<Environment, 'name' | 'variables'>,
  opts: ResolveOptions,
): ResolvedVars {
  const processEnv = opts.processEnv ?? process.env;
  const resolved = new Map<string, { value: string; secret: boolean }>();

  for (const variable of env.variables) {
    const { key, secret } = variable;
    let value: string | undefined;
    if (variable.source === 'env') {
      const envVar = variable.envVar ?? key;
      value = processEnv[envVar];
      if (value === undefined) {
        throw new S1PilotError(
          'MISSING_ENV_VAR',
          `Environment variable ${envVar} (needed by variable "${key}" in environment "${env.name}") is not set`,
          { key, envVar, environment: env.name },
        );
      }
    } else if (secret) {
      const cipher = opts.ciphertexts?.[key];
      if (cipher === undefined) {
        throw new S1PilotError(
          'MISSING_SECRET',
          `Secret variable "${key}" in environment "${env.name}" has no stored value`,
          { key, environment: env.name },
        );
      }
      value = opts.vault.decrypt(cipher);
    } else {
      value = variable.value;
      if (value === undefined) {
        throw new S1PilotError('MISSING_VALUE', `Variable "${key}" in environment "${env.name}" has no value`, {
          key,
          environment: env.name,
        });
      }
    }
    resolved.set(key, { value, secret });
  }

  return {
    get: (key) => resolved.get(key)?.value,
    isSecret: (key) => resolved.get(key)?.secret ?? false,
    keys: () => [...resolved.keys()],
    publicView: () =>
      Object.fromEntries([...resolved].map(([key, v]) => [key, v.secret ? `«secret:${key}»` : v.value])),
    secretValues: () => [...resolved.values()].filter((v) => v.secret).map((v) => v.value),
  };
}
