import pino, { type DestinationStream, type LogFn, type Logger } from 'pino';

import type { Redactor } from './redact.js';

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
  /** Applied to every log argument via `redactDeep` (build it from the run's resolved secrets). */
  redactor?: Redactor;
  /** Test hook: where to write instead of stdout. */
  destination?: DestinationStream;
}

/**
 * Creates a pino logger with key-based redaction and an optional value redactor.
 * Library code must log through this, never `console`.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const { name, level = 'info', redactor, destination } = options;
  const config = {
    ...(name !== undefined ? { name } : {}),
    level,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(redactor !== undefined
      ? {
          hooks: {
            logMethod(this: Logger, args: unknown[], method: LogFn) {
              method.apply(this, redactor.redactDeep(args) as Parameters<LogFn>);
            },
          },
        }
      : {}),
  };
  return destination !== undefined ? pino(config, destination) : pino(config);
}
