import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { S1PilotError } from '@s1pilot/domain/errors';
import { z } from 'zod';

/** Validated server configuration. */
export const ConfigSchema = z.object({
  port: z.number().int().min(0).max(65535),
  host: z.string().min(1),
  dataDir: z.string().min(1),
  dbUrl: z.string().min(1),
  artifactsDir: z.string().min(1),
  mode: z.enum(['local', 'team']),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
});
export type ServerConfig = z.infer<typeof ConfigSchema>;

type Raw = Partial<Record<keyof ServerConfig, unknown>>;

/** `./.s1pilot` when it exists in the working directory, else `~/.s1pilot`. */
function defaultDataDir(cwd: string): string {
  const local = join(cwd, '.s1pilot');
  return existsSync(local) ? local : join(homedir(), '.s1pilot');
}

const ENV_KEYS: Record<string, keyof ServerConfig> = {
  S1PILOT_PORT: 'port',
  S1PILOT_HOST: 'host',
  S1PILOT_DATA_DIR: 'dataDir',
  S1PILOT_DB_URL: 'dbUrl',
  S1PILOT_ARTIFACTS_DIR: 'artifactsDir',
  S1PILOT_MODE: 'mode',
  S1PILOT_LOG_LEVEL: 'logLevel',
};

/**
 * Builds the config from (lowest to highest priority) defaults, `S1PILOT_*` env vars and explicit overrides.
 * @throws S1PilotError `CONFIG_ERROR` when a value is invalid.
 */
export function loadConfig(
  overrides: Raw = {},
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ServerConfig {
  const merged: Raw = {};
  for (const [name, key] of Object.entries(ENV_KEYS)) {
    const v = env[name];
    if (v !== undefined) merged[key] = key === 'port' ? Number(v) : v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) merged[k as keyof ServerConfig] = v;
  }

  const dataDir = resolve(cwd, typeof merged.dataDir === 'string' ? merged.dataDir : defaultDataDir(cwd));
  const parsed = ConfigSchema.safeParse({
    port: 5317,
    host: '127.0.0.1',
    mode: 'local',
    logLevel: 'info',
    dbUrl: `file:${join(dataDir, 'data.db')}`,
    artifactsDir: join(dataDir, 'artifacts'),
    ...merged,
    dataDir,
  });
  if (!parsed.success) {
    throw new S1PilotError('CONFIG_ERROR', `Invalid server config: ${parsed.error.message}`, {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return parsed.data;
}

const FLAGS: Record<string, keyof ServerConfig> = {
  '--port': 'port',
  '--host': 'host',
  '--data-dir': 'dataDir',
  '--db-url': 'dbUrl',
  '--artifacts-dir': 'artifactsDir',
  '--mode': 'mode',
  '--log-level': 'logLevel',
};

/** Parses `--port --host --data-dir --db-url --artifacts-dir --mode --log-level` flags into config overrides. */
export function parseServerArgs(argv: readonly string[]): Raw {
  const out: Raw = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? '';
    const key = FLAGS[flag];
    if (key === undefined) continue;
    const value = argv[++i];
    if (value === undefined) throw new S1PilotError('CONFIG_ERROR', `Missing value for ${flag}`);
    out[key] = key === 'port' ? Number(value) : value;
  }
  return out;
}
