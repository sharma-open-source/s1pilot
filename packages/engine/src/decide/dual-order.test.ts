import type { DecideRequest, Thresholds } from '@s1pilot/domain';
import { MockChatModel, MockDecisionModel } from '@s1pilot/providers';
import { describe, expect, it } from 'vitest';

import { decideDualOrder } from './dual-order.js';
import { gate } from './gate.js';

const thresholds: Thresholds = { act: 0.8, pass: 0.8, fail: 0.2, escalate: 0.5 };
const req: DecideRequest = {
  state: { url: 'https://x.test' },
  questions: {
    q: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B', c: 'C' } },
    n: { type: 'noul', instructions: 'Is it ok?' },
  },
};

const qOnly: DecideRequest = { ...req, questions: { q: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B', c: 'C' } } } };
const nOnly: DecideRequest = { ...req, questions: { n: { type: 'noul', instructions: 'Is it ok?' } } };

describe('decideDualOrder', () => {
  it('reverses option order for the second call and keeps ids stable', async () => {
    const model = new MockDecisionModel({ script: [{ match: (q) => q.type === 'choice', answer: { choice: 'b', confidence: 0.9 } }] });
    const out = await decideDualOrder(model, req);
    expect(model.calls).toHaveLength(2);
    const second = model.calls[1]?.request.questions.q;
    expect(second?.type === 'choice' && Object.keys(second.criteria)).toEqual(['c', 'b', 'a']);
    expect(out.q).toMatchObject({ choice: 'b', disagreement: false });
    expect(out.q?.confidence).toBeCloseTo(0.9);
    expect(out.n?.disagreement).toBe(false);
    // noul is not re-asked
    expect(Object.keys(model.calls[1]?.request.questions ?? {})).toEqual(['q']);
  });

  it('averages probabilities and recomputes confidence as max(p)', async () => {
    let n = 0;
    const model = new MockDecisionModel({
      script: [
        {
          match: (q) => q.type === 'choice',
          answer: () => ({ choice: 'a', probabilities: n++ === 0 ? { a: 0.9, b: 0.05, c: 0.05 } : { a: 0.5, b: 0.4, c: 0.1 } }),
        },
      ],
    });
    const out = await decideDualOrder(model, qOnly);
    expect(out.q?.probabilities.a).toBeCloseTo(0.7);
    expect(out.q?.confidence).toBeCloseTo(0.7);
    expect(out.q?.choice).toBe('a');
  });

  it('seeded shuffle is deterministic', async () => {
    const orders: string[][] = [];
    for (let i = 0; i < 2; i++) {
      const model = new MockDecisionModel();
      await decideDualOrder(model, req, { order: { seed: 42 } });
      const q = model.calls[1]?.request.questions.q;
      orders.push(q?.type === 'choice' ? Object.keys(q.criteria) : []);
    }
    expect(orders[0]).toEqual(orders[1]);
    expect([...(orders[0] ?? [])].sort()).toEqual(['a', 'b', 'c']);
  });

  it('makes a single call when there is no choice question', async () => {
    const model = new MockDecisionModel();
    await decideDualOrder(model, nOnly);
    expect(model.calls).toHaveLength(1);
  });

  it('disagreement forces escalation even when both confidences >= act', async () => {
    // Position-biased model: always picks the first listed option at 0.95.
    const biased = new MockDecisionModel({
      fallback: (q) => ({ choice: q.type === 'choice' ? (Object.keys(q.criteria)[0] as string) : '', confidence: 0.95 }),
    });
    const out = await decideDualOrder(biased, qOnly);
    const both = biased.calls.map((c) => c.response.q?.confidence ?? 0);
    expect(both.every((c) => c >= thresholds.act)).toBe(true);
    expect(out.q?.disagreement).toBe(true);
    const answer = out.q;
    if (answer === undefined) throw new Error('missing answer');

    const options = { a: 'A', b: 'B', c: 'C' };
    // Without System 2 and unattended: blocked despite high confidence in both calls.
    const blocked = await gate(answer, {
      thresholds,
      questionId: 'q',
      question: 'Which?',
      options,
      model: 'mock',
      attended: false,
      disagreement: answer.disagreement,
    });
    expect(blocked.outcome).toBe('blocked');
    // The same answer without the flag would have acted.
    const acted = await gate({ ...answer, confidence: 0.95 }, { thresholds, questionId: 'q', question: 'Which?', options, model: 'mock', attended: false });
    expect(acted.outcome).toBe('act');
    // With System 2 it escalates to System 2 rather than acting directly.
    const s2 = new MockChatModel({ pick: () => 'a' });
    await gate(answer, { thresholds: { ...thresholds, escalate: 0.3 }, questionId: 'q', question: 'Which?', options, model: 'mock', attended: false, s2, disagreement: true });
    expect(s2.pickCalls).toHaveLength(1);
  });
});
