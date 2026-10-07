import type { DecideRequest } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { MockChatModel, MockDecisionModel, fallbacks } from './mock.js';

const request: DecideRequest = {
  state: { url: '/cart', elements: ['Buy', 'Cancel'] },
  questions: {
    next_action: { type: 'choice', instructions: 'Next?', criteria: { e1: 'Buy button', e2: 'Cancel button', e3: 'Back link' } },
    step_done: { type: 'noul', instructions: 'Done?' },
    quality: { type: 'score', instructions: 'Rate', criteria: ['low', 'mid', 'high'] },
  },
};

describe('MockDecisionModel scripting', () => {
  it('answers a choice question with the scripted option, probabilities and confidence', async () => {
    const model = new MockDecisionModel({
      script: [{ match: (q) => q.type === 'choice', answer: { choice: 'e3', confidence: 0.8 } }],
    });
    const out = await model.decide(request);
    expect(out['next_action']).toMatchObject({ choice: 'e3', confidence: 0.8 });
    expect(out['next_action']?.probabilities['e3']).toBeCloseTo(0.8);
    expect(out['next_action']?.probabilities['e1']).toBeCloseTo(0.1);
    expect(Object.values(out['next_action']?.probabilities ?? {}).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('defaults to 0.9 confidence and supports noul / score / explicit probabilities', async () => {
    const model = new MockDecisionModel({
      script: [
        { match: (_q, _s, id) => id === 'step_done', answer: { noul: 0.2 } },
        { match: (_q, _s, id) => id === 'quality', answer: { score: 2 } },
        { match: (_q, _s, id) => id === 'next_action', answer: { probabilities: { e1: 6, e2: 2, e3: 2 } } },
      ],
    });
    const out = await model.decide(request);
    expect(out['step_done']).toMatchObject({ noul: 0.2, confidence: 0.8 });
    expect(out['quality']).toMatchObject({ score: 2, confidence: 0.9 });
    expect(out['next_action']).toMatchObject({ choice: 'e1', confidence: 0.6 });
  });

  it('matches on the observation and uses the first matching rule', async () => {
    const model = new MockDecisionModel({
      script: [
        { match: (q, state) => q.type === 'choice' && JSON.stringify(state).includes('/cart'), answer: { choice: 'e2' } },
        { match: (q) => q.type === 'choice', answer: { choice: 'e1' } },
      ],
    });
    expect((await model.decide(request))['next_action']?.choice).toBe('e2');
    expect((await model.decide({ ...request, state: { url: '/home' } }))['next_action']?.choice).toBe('e1');
  });

  it('supports resolver functions and rejects an unknown scripted option', async () => {
    const dynamic = new MockDecisionModel({
      script: [{ match: (q) => q.type === 'choice', answer: (q) => ({ choice: Object.keys((q as { criteria: object }).criteria).at(-1) as string }) }],
    });
    expect((await dynamic.decide(request))['next_action']?.choice).toBe('e3');
    const wrong = new MockDecisionModel({ script: [{ match: () => true, answer: { choice: 'e9' } }] });
    await expect(wrong.decide(request)).rejects.toMatchObject({ code: 'MODEL_BAD_RESPONSE' });
  });

  it('records every call with its request and response', async () => {
    const model = new MockDecisionModel();
    await model.decide(request);
    await model.decide({ ...request, state: 'second' });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.request.state).toBe('second');
    expect(Object.keys(model.calls[0]?.response ?? {})).toEqual(['next_action', 'step_done', 'quality']);
  });

  it('fans out when configured as single-question-per-call', async () => {
    const model = new MockDecisionModel({ capabilities: { multiQuestionPerCall: false } });
    const out = await model.decide(request);
    expect(Object.keys(out)).toEqual(['next_action', 'step_done', 'quality']);
    expect(model.calls).toHaveLength(1);
  });
});

describe('fallback strategies', () => {
  it('first: first option, level 0, P(true) 0.9', async () => {
    const out = await new MockDecisionModel({ fallback: fallbacks.first() }).decide(request);
    expect(out['next_action']?.choice).toBe('e1');
    expect(out['quality']?.score).toBe(0);
    expect(out['step_done']?.noul).toBe(0.9);
  });

  it('random(seed): deterministic per seed, varied across calls', async () => {
    const run = async (seed: number) => {
      const model = new MockDecisionModel({ fallback: fallbacks.random(seed) });
      const picks: string[] = [];
      for (let i = 0; i < 20; i++) picks.push((await model.decide(request))['next_action']?.choice as string);
      return picks;
    };
    expect(await run(42)).toEqual(await run(42));
    expect(await run(42)).not.toEqual(await run(7));
    expect(new Set(await run(42)).size).toBeGreaterThan(1);
  });

  it('byLabelIncludes: picks by option text and observation text', async () => {
    const model = new MockDecisionModel({ fallback: fallbacks.byLabelIncludes('cancel') });
    const out = await model.decide(request);
    expect(out['next_action']?.choice).toBe('e2');
    expect(out['step_done']?.noul).toBe(0.9);
    expect((await new MockDecisionModel({ fallback: fallbacks.byLabelIncludes('zzz') }).decide(request))['next_action']?.choice).toBe('e1');
  });
});

describe('MockChatModel', () => {
  it('returns queued replies, then the fallback, and records calls', async () => {
    const chat = new MockChatModel({ replies: ['one', (req) => `echo:${req.messages[0]?.content}`], fallbackReply: 'done' });
    expect((await chat.chat({ messages: [{ role: 'user', content: 'a' }] })).text).toBe('one');
    expect((await chat.chat({ messages: [{ role: 'user', content: 'b' }] })).text).toBe('echo:b');
    expect((await chat.chat({ messages: [] })).text).toBe('done');
    expect(chat.chatCalls).toHaveLength(3);
  });

  it('picks the first option by default, a scripted one on request, and rejects unknown ids', async () => {
    const req = { context: 'page', question: 'Which?', options: { a: 'A', b: 'B' } };
    expect((await new MockChatModel().pickOption(req)).choice).toBe('a');
    expect((await new MockChatModel({ pick: () => 'b' }).pickOption(req)).choice).toBe('b');
    await expect(new MockChatModel({ pick: () => 'zzz' }).pickOption(req)).rejects.toMatchObject({ code: 'MODEL_BAD_RESPONSE' });
  });
});
