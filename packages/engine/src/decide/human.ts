import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { S1PilotError } from '@s1pilot/domain';

/** Everything a human needs to resolve an escalated decision. */
export interface HumanAskRequest {
  /** The question being decided (instructions text). */
  question: string;
  /** Option id → description. */
  options: Record<string, string>;
  /** Option id → model probability. */
  probabilities: Record<string, number>;
  /** Base64 PNG of the current page, when available. */
  screenshot?: string;
  /** Why the human is being asked (low confidence, disagreement, sensitive action, ...). */
  reason: string;
}

/** A human's answer to an escalation. */
export type HumanResponse = { choice: string } | { skip: true } | { abort: true } | { takeover: true };

/**
 * Asks a human to resolve a decision. Implementations that cannot reach a human must reject with
 * `S1PilotError('HUMAN_UNAVAILABLE')`; the gate then treats the decision as blocked.
 */
export interface HumanHook {
  ask(req: HumanAskRequest): Promise<HumanResponse>;
}

/** Error code a hook throws when no human can be reached. */
export const HUMAN_UNAVAILABLE = 'HUMAN_UNAVAILABLE';

export interface ReadlineHumanOptions {
  input?: Readable;
  output?: Writable;
  /** Whether the streams are interactive. Defaults to `input.isTTY`. */
  isTTY?: boolean;
}

/**
 * CLI default {@link HumanHook}: a readline prompt on a TTY. On a non-TTY it rejects with
 * `HUMAN_UNAVAILABLE` without reading anything. Streams are injectable for tests.
 */
export function createReadlineHumanHook(options: ReadlineHumanOptions = {}): HumanHook {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive = options.isTTY ?? (input as { isTTY?: boolean }).isTTY === true;

  return {
    async ask(req) {
      if (!interactive) {
        throw new S1PilotError(HUMAN_UNAVAILABLE, 'No interactive terminal available to ask a human', {
          reason: req.reason,
        });
      }
      const ids = Object.keys(req.options);
      const lines = [
        '',
        `Human input needed: ${req.reason}`,
        req.question,
        ...ids.map((id, i) => {
          const p = req.probabilities[id];
          return `  ${i + 1}) ${id} - ${req.options[id]}${p === undefined ? '' : ` (p=${p.toFixed(2)})`}`;
        }),
        '  s) skip   a) abort   t) take over',
      ];
      output.write(`${lines.join('\n')}\n`);
      const prompt = `Choose [1-${ids.length}/id/s/a/t]: `;
      const rl = createInterface({ input, terminal: false });
      try {
        output.write(prompt);
        for await (const raw of rl) {
          const answer = raw.trim();
          const lower = answer.toLowerCase();
          if (lower === 's' || lower === 'skip') return { skip: true };
          if (lower === 'a' || lower === 'abort') return { abort: true };
          if (lower === 't' || lower === 'takeover') return { takeover: true };
          if (ids.includes(answer)) return { choice: answer };
          const index = Number(answer);
          const byIndex = Number.isInteger(index) ? ids[index - 1] : undefined;
          if (byIndex !== undefined) return { choice: byIndex };
          output.write(`Not a valid answer.\n${prompt}`);
        }
      } finally {
        rl.close();
      }
      throw new S1PilotError(HUMAN_UNAVAILABLE, 'Input closed before a human answered');
    },
  };
}
