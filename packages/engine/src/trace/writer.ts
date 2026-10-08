import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { TraceLine } from './schema.js';

/** Sink for trace lines. The runner can supply an implementation backed by the artifact store. */
export interface TraceWriter {
  write(line: TraceLine): void | Promise<void>;
  /** Flushes and releases resources, if any. */
  close?(): void | Promise<void>;
}

/** Appends one JSON object per line to `filePath` (conventionally `<case dir>/trace.jsonl`). */
export function createJsonlTraceWriter(filePath: string): TraceWriter {
  let ready: Promise<unknown> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    write(line) {
      ready ??= mkdir(dirname(filePath), { recursive: true });
      const data = `${JSON.stringify(line)}\n`;
      const dir = ready;
      queue = queue.then(() => dir).then(() => appendFile(filePath, data, 'utf8'));
      return queue.then(() => undefined);
    },
    async close() {
      await queue;
    },
  };
}

/** Keeps lines in memory (tests, previews). */
export function createMemoryTraceWriter(): TraceWriter & { readonly lines: TraceLine[] } {
  const lines: TraceLine[] = [];
  return {
    lines,
    write(line) {
      lines.push(line);
    },
  };
}
