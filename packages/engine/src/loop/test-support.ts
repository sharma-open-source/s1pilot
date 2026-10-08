import type { Capabilities } from '@s1pilot/domain';
import type { MockResolver } from '@s1pilot/providers';

import type { InputVars, VarLookup } from '../text-input/index.js';

/** Capabilities used by loop tests. */
export const MOCK_CAPS_FOR_TESTS: Capabilities = {
  maxOptions: 256,
  multiQuestionPerCall: true,
  supportsImages: false,
  maxContextTokens: 32768,
  orderSensitive: false,
};

/** In-memory variables for tests. */
export function makeVars(entries: Record<string, { value: string; secret?: boolean }>): InputVars & VarLookup {
  return {
    keys: () => Object.keys(entries),
    isSecret: (k) => entries[k]?.secret === true,
    secretValues: () => Object.values(entries).filter((e) => e.secret).map((e) => e.value),
    get: (k) => entries[k]?.value,
  };
}

/**
 * Mock System 1 script. `plan` maps a step text to the option descriptions (`[role] name`) to pick
 * in order; once exhausted the model answers `step_done` and reports the step as done. Also picks
 * test-data keys for `input_key` questions by field label.
 */
export function scriptedS1(plan: Record<string, string[]>): MockResolver {
  const calls = new Map<string, number>();
  return (question, state, id) => {
    const step = (state as { step?: string } | undefined)?.step ?? '';
    if (id === 'input_key' && question.type === 'choice') {
      const label = question.instructions.toLowerCase();
      const keys = Object.keys(question.criteria);
      const want = label.includes('zip') ? 'zip' : label.includes('name') ? 'shipping_name' : label.includes('email') ? 'email' : label.includes('pass') ? 'password' : label.includes('search') ? 'search' : '';
      return { choice: keys.find((k) => k.includes(want)) ?? 'none_fits' };
    }
    if (id !== 'next_action' && id !== 'step_done' && id !== 'blocked') {
      return question.type === 'choice' ? { choice: Object.keys(question.criteria)[0] as string } : { noul: 0.5 };
    }
    const queue = Object.entries(plan).find(([text]) => step.startsWith(text))?.[1] ?? [];
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
