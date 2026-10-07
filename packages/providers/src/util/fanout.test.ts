import type { DecideAnswer, DecideRequest } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { fanOut } from './fanout.js';

const answer = (id: string): DecideAnswer => ({ noul: 0.9, probabilities: { true: 0.9, false: 0.1 }, confidence: 0.9, choice: id });

function request(n: number): DecideRequest {
  return { state: {}, questions: Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, { type: 'noul' as const, instructions: `Q${i}` }])) };
}

describe('fanOut', () => {
  it('makes one call when the model takes several questions', async () => {
    let calls = 0;
    const result = await fanOut(request(3), { multiQuestionPerCall: true }, async (req) => {
      calls++;
      return Object.fromEntries(Object.keys(req.questions).map((id) => [id, answer(id)]));
    });
    expect(calls).toBe(1);
    expect(Object.keys(result)).toEqual(['q0', 'q1', 'q2']);
  });

  it('splits into single-question calls and merges answers keyed by question id, in request order', async () => {
    const seen: string[][] = [];
    const result = await fanOut(request(5), { multiQuestionPerCall: false }, async (req) => {
      const ids = Object.keys(req.questions);
      seen.push(ids);
      await new Promise((r) => setTimeout(r, ids[0] === 'q0' ? 20 : 1)); // q0 finishes last
      return { [ids[0] as string]: answer(ids[0] as string) };
    });
    expect(seen.every((ids) => ids.length === 1)).toBe(true);
    expect(Object.keys(result)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
    expect(result['q3']?.choice).toBe('q3');
  });

  it('never runs more than 4 calls at once', async () => {
    let active = 0;
    let peak = 0;
    await fanOut(request(12), { multiQuestionPerCall: false }, async (req) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      const id = Object.keys(req.questions)[0] as string;
      return { [id]: answer(id) };
    });
    expect(peak).toBe(4);
  });

  it('honours a custom concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await fanOut(request(6), { multiQuestionPerCall: false }, async (req) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      const id = Object.keys(req.questions)[0] as string;
      return { [id]: answer(id) };
    }, 2);
    expect(peak).toBe(2);
  });

  it('fails when an answer is missing, and propagates call errors', async () => {
    await expect(fanOut(request(2), { multiQuestionPerCall: true }, async () => ({ q0: answer('q0') }))).rejects.toMatchObject({
      code: 'MODEL_BAD_RESPONSE',
      message: expect.stringContaining('q1'),
    });
    await expect(
      fanOut(request(3), { multiQuestionPerCall: false }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('handles an empty question set', async () => {
    expect(await fanOut({ state: {}, questions: {} }, { multiQuestionPerCall: false }, async () => ({}))).toEqual({});
  });
});
