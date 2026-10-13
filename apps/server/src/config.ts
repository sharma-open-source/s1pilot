import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { S1PilotError } from '@s1pilot/domain/errors';
import { z } from 'zod';

/** OpenID Connect provider for team-mode SSO (S-067). The client secret comes from the environment only. */
export const OidcConfigSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  /** Button label on the login page. */
  label: z.string().min(1).optional(),
  scopes: z.string().min(1).optional(),
  /** Allow a plain-http issuer that is not on localhost (never in production). */
  allowInsecure: z.boolean().optional(),
});
export type OidcConfig = z.infer<typeof OidcConfigSchema>;

/** Validated server configuration. */
export const ConfigSchema = z.object({
  port: z.number().int().min(0).max(65535),
  host: z.string().min(1),
  dataDir: z.string().min(1),
  dbUrl: z.string().min(1),
  /** `postgres://` URL of the pg-boss job queue (team mode, S-066). Unset = the SQLite queue in the data dir. */
  queueUrl: z.string().min(1).optional(),
  artifactsDir: z.string().min(1),
  /** S3-compatible bucket for artifacts (S-068). Unset = the file system under `artifactsDir`. Credentials: AWS env vars / role. */
  s3Bucket: z.string().min(1).optional(),
  /** Endpoint of an S3-compatible service such as MinIO (`http://minio:9000`). */
  s3Endpoint: z.string().url().optional(),
  /** Endpoint browsers reach the bucket at, when it differs from `s3Endpoint` (presigned URLs use it). */
  s3PublicEndpoint: z.string().url().optional(),
  s3Region: z.string().min(1).optional(),
  /** Key prefix inside the bucket. */
  s3Prefix: z.string().optional(),
  /** Redirect artifact downloads to presigned bucket URLs (default) instead of proxying the bytes through the server. */
  s3Presign: z.boolean().optional(),
  /** Bootstrap API token (`s1p_<8 hex>_<48 hex>`, `runs:write`) remote workers authenticate with; created at startup when missing. Env only. */
  workerToken: z.string().min(1).optional(),
  /** Seconds a remote worker may go silent before its leased jobs are re-queued (S-068). Default 30. */
  workerLeaseSec: z.number().positive().optional(),
  mode: z.enum(['local', 'team']),
  /** Externally visible origin (OIDC redirect URI, `Secure` cookies), e.g. `https://s1pilot.example.com`. Default: from the request. */
  publicUrl: z.string().url().optional(),
  /** Team-mode single sign-on. Env: `S1PILOT_OIDC_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_LABEL`, `_SCOPES`. */
  oidc: OidcConfigSchema.optional(),
  /** In-process workers executing queued runs (0 disables execution). */
  workers: z.number().int().min(0).max(32),
  /** Minutes an attended run waits for a human to answer an escalation before the step is `blocked` (S-037). */
  escalationTimeoutMin: z.number().positive(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
});
export type ServerConfig = z.infer<typeof ConfigSchema>;

type Raw = Partial<Record<keyof ServerConfig, unknown>>;

/** `./.s1pilot` when it exists in the working directory, else `~/.s1pilot`. */
function defaultDataDir(cwd: string): string {
  const local = join(cwd, '.s1pilot');
  return existsSync(local) ? local : join(homedir(), '.s1pilot');
}

const NUMERIC_KEYS: ReadonlySet<keyof ServerConfig> = new Set(['port', 'workers', 'escalationTimeoutMin', 'workerLeaseSec']);

/** Env / flag strings to the typed config value. */
function coerce(key: keyof ServerConfig, value: string): unknown {
  if (NUMERIC_KEYS.has(key)) return Number(value);
  if (key === 's3Presign') return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
  return value;
}

const ENV_KEYS: Record<string, keyof ServerConfig> = {
  S1PILOT_PORT: 'port',
  S1PILOT_HOST: 'host',
  S1PILOT_DATA_DIR: 'dataDir',
  S1PILOT_DB_URL: 'dbUrl',
  S1PILOT_QUEUE_URL: 'queueUrl',
  S1PILOT_ARTIFACTS_DIR: 'artifactsDir',
  S1PILOT_S3_BUCKET: 's3Bucket',
  S1PILOT_S3_ENDPOINT: 's3Endpoint',
  S1PILOT_S3_PUBLIC_ENDPOINT: 's3PublicEndpoint',
  S1PILOT_S3_REGION: 's3Region',
  S1PILOT_S3_PREFIX: 's3Prefix',
  S1PILOT_S3_PRESIGN: 's3Presign',
  S1PILOT_WORKER_LEASE_SEC: 'workerLeaseSec',
  S1PILOT_WORKER_TOKEN: 'workerToken',
  S1PILOT_MODE: 'mode',
  S1PILOT_PUBLIC_URL: 'publicUrl',
  S1PILOT_LOG_LEVEL: 'logLevel',
  S1PILOT_WORKERS: 'workers',
  S1PILOT_ESCALATION_TIMEOUT_MIN: 'escalationTimeoutMin',
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
    if (v !== undefined) merged[key] = coerce(key, v);
  }
  const issuer = env['S1PILOT_OIDC_ISSUER'];
  if (issuer !== undefined) {
    merged.oidc = {
      issuer,
      clientId: env['S1PILOT_OIDC_CLIENT_ID'],
      clientSecret: env['S1PILOT_OIDC_CLIENT_SECRET'],
      ...(env['S1PILOT_OIDC_LABEL'] ? { label: env['S1PILOT_OIDC_LABEL'] } : {}),
      ...(env['S1PILOT_OIDC_SCOPES'] ? { scopes: env['S1PILOT_OIDC_SCOPES'] } : {}),
    };
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
    workers: 1,
    escalationTimeoutMin: 30,
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
  '--queue-url': 'queueUrl',
  '--artifacts-dir': 'artifactsDir',
  '--s3-bucket': 's3Bucket',
  '--s3-endpoint': 's3Endpoint',
  '--s3-public-endpoint': 's3PublicEndpoint',
  '--s3-region': 's3Region',
  '--s3-prefix': 's3Prefix',
  '--worker-lease-sec': 'workerLeaseSec',
  '--mode': 'mode',
  '--log-level': 'logLevel',
  '--workers': 'workers',
  '--escalation-timeout-min': 'escalationTimeoutMin',
};

/** Parses `--port --host --data-dir --db-url --queue-url --artifacts-dir --mode --log-level --workers` flags into config overrides. */
export function parseServerArgs(argv: readonly string[]): Raw {
  const out: Raw = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? '';
    const key = FLAGS[flag];
    if (key === undefined) continue;
    const value = argv[++i];
    if (value === undefined) throw new S1PilotError('CONFIG_ERROR', `Missing value for ${flag}`);
    out[key] = coerce(key, value);
  }
  return out;
}
