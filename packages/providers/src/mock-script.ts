import { readFileSync } from 'node:fs';

import { S1PilotError } from '@s1pilot/domain';
import { z } from 'zod';

import type { MockResolver } from './adapters/mock.js';

/**
 * `--mock-script` file (JSON) driving the `mock` adapter, so cases run end to end without a model:
 * - `steps`: step text prefix (after `{param}` binding) -> option descriptions (`[role] name`) to pick, in order;
 *   once the list is exhausted the mock reports the step as done.
 * - `inputs`: lower-case field-label fragment -> test-data key fragment, for text input.
 * - `expected`: probability that an `expected` text / `ai` assertion holds (default 0.95).
 */
export const MockScriptSchema = z.object({
  steps: z.record(z.array(z.string())).default({}),
  inputs: z.record(z.string()).default({}),
  expected: z.number().min(0).max(1).default(0.95),
});
export type MockScript = z.infer<typeof MockScriptSchema>;

/** Reads and validates a mock script file; throws `MOCK_SCRIPT_INVALID` otherwise. */
export function loadMockScript(path: string): MockScript {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new S1PilotError('MOCK_SCRIPT_INVALID', `Cannot read mock script ${path}: ${error instanceof Error ? error.message : String(error)}`, { path });
  }
  const parsed = MockScriptSchema.safeParse(raw);
  if (!parsed.success) {
    throw new S1PilotError('MOCK_SCRIPT_INVALID', `Mock script ${path} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, { path });
  }
  return parsed.data;
}

/** Builds the mock System 1 resolver for a {@link MockScript}. */
export function mockResolver(script: MockScript): MockResolver {
  const calls = new Map<string, number>();
  return (question, state, id) => {
    const step = (state as { step?: string } | undefined)?.step ?? '';
    if (id === 'expected_true') return { noul: script.expected };
    if (id === 'expected_true_negated') return { noul: 1 - script.expected };
    if (id === 'input_key' && question.type === 'choice') {
      const label = question.instructions.toLowerCase();
      const keys = Object.keys(question.criteria);
      const hit = Object.entries(script.inputs).find(([fragment]) => label.includes(fragment.toLowerCase()));
      return { choice: (hit && keys.find((k) => k.includes(hit[1]))) ?? 'none_fits' };
    }
    if (id !== 'next_action' && id !== 'step_done' && id !== 'blocked') {
      return question.type === 'choice' ? { choice: Object.keys(question.criteria)[0] as string } : { noul: 0.5 };
    }
    const queue = Object.entries(script.steps).find(([text]) => step.startsWith(text))?.[1] ?? [];
    if (id === 'next_action') calls.set(step, (calls.get(step) ?? 0) + 1);
    const n = calls.get(step) ?? 0;
    if (id === 'blocked') return { noul: 0.02 };
    if (id === 'step_done') return { noul: n > queue.length ? 0.97 : 0.03 };
    if (question.type !== 'choice') return { noul: 0.5 };
    const want = queue[n - 1];
    const hit = want === undefined ? 'step_done' : Object.entries(question.criteria).find(([, d]) => d === want)?.[0];
    return { choice: hit ?? 'stuck' };
  };
}
