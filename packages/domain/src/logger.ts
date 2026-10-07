import pino, { type DestinationStream, type LogFn, type Logger } from 'pino';

/** Field names whose values are always censored. */
const REDACT_PATHS = [
  'password',
  'token',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.authorization',
  '*.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
];

export interface LoggerOptions {
  name?: string;
  level?: string;
  /** Applied to every string in the log arguments (e.g. the secret vault's scrubber, S-004). */
  redactValue?: (value: string) => string;
  /** Test hook: where to write instead of stdout. */
  destination?: DestinationStream;
}

function scrub(value: unknown, redactValue: (v: string) => string, depth = 0): unknown {
  if (typeof value === 'string') return redactValue(value);
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, redactValue, depth + 1));
  if (value instanceof Error) return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, scrub(v, redactValue, depth + 1)]),
  );
}

/**
 * Creates a pino logger with key-based redaction and an optional value-redaction hook.
 * Library code must log through this, never `console`.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const { name, level = 'info', redactValue, destination } = options;
  const config = {
    ...(name !== undefined ? { name } : {}),
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(redactValue !== undefined
      ? {
          hooks: {
            logMethod(this: Logger, args: unknown[], method: LogFn) {
              method.apply(this, scrub(args, redactValue) as Parameters<LogFn>);
            },
          },
        }
      : {}),
  };
  return destination !== undefined ? pino(config, destination) : pino(config);
}
