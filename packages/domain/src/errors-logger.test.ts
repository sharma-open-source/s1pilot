import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { S1PilotError } from './errors.js';
import { createLogger } from './logger.js';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('S1PilotError', () => {
  it('carries code, message and details', () => {
    const err = new S1PilotError('X', 'boom', { a: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: 'S1PilotError', code: 'X', message: 'boom', details: { a: 1 } });
  });
});

describe('createLogger', () => {
  it('censors sensitive keys', () => {
    const { stream, lines } = capture();
    createLogger({ destination: stream }).info({ password: 'hunter2', user: { token: 't0k' }, ok: 1 }, 'hi');
    const [line] = lines();
    expect(line).toMatchObject({ password: '[REDACTED]', user: { token: '[REDACTED]' }, ok: 1, msg: 'hi' });
  });

  it('applies the value redaction hook to messages and nested strings', () => {
    const { stream, lines } = capture();
    const log = createLogger({ destination: stream, redactValue: (v) => v.replaceAll('s3cret', '***') });
    log.info({ note: 'has s3cret inside' }, 'token s3cret leaked');
    const [line] = lines();
    expect(line).toMatchObject({ note: 'has *** inside', msg: 'token *** leaked' });
    expect(JSON.stringify(line)).not.toContain('s3cret');
  });
});
