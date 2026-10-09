import type { DecideAnswer, Thresholds } from '@s1pilot/domain';
import { S1PilotError } from '@s1pilot/domain';
import { MockChatModel } from '@s1pilot/providers';
import { describe, expect, it, vi } from 'vitest';

import { gate, type GateOptions } from './gate.js';
import { HUMAN_UNAVAILABLE, type HumanHook, type HumanResponse } from './human.js';

const thresholds: Thresholds = { act: 0.8, pass: 0.8, fail: 0.2, escalate: 0.5 };
const options = { a: 'Click Buy', b: 'Click Cancel', stuck: 'I am stuck', blocked: 'Blocked' };

function answer(choice: string | undefined, confidence: number): DecideAnswer {
  const rest = (1 - confidence) / 3;
  const probabilities = Object.fromEntries(Object.keys(options).map((k) => [k, k === choice ? confidence : rest]));
  return { ...(choice === undefined ? {} : { choice }), probabilities, confidence };
}

function fakeHuman(response: HumanResponse | Error = { choice: 'b' }) {
  const ask = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const hook: HumanHook = { ask };
  return { hook, ask };
}

function base(overrides: Partial<GateOptions> = {}): GateOptions {
  return {
    thresholds,
    questionId: 'q1',
    question: 'What next?',
    options,
    model: 'mock',
    attended: true,
    ...overrides,
  };
}

describe('gate: plan section 7 table', () => {
  it('row 1: confidence >= act acts automatically without escalation', async () => {
    const human = fakeHuman();
    const s2 = new MockChatModel();
    const r = await gate(answer('a', 0.9), base({ human: human.hook, s2 }));
    expect(r).toMatchObject({ outcome: 'act', choice: 'a' });
    expect(r.record.chosen).toBe('a');
    expect(r.record.escalatedTo).toBeUndefined();
    expect(human.ask).not.toHaveBeenCalled();
    expect(s2.pickCalls).toHaveLength(0);
  });

  it('row 2a: middle band, System 2 agrees -> act, escalatedTo system2', async () => {
    const s2 = new MockChatModel({ pick: () => 'a' });
    const human = fakeHuman();
    const r = await gate(answer('a', 0.65), base({ s2, human: human.hook }));
    expect(r).toMatchObject({ outcome: 'act', choice: 'a' });
    expect(r.record.escalatedTo).toBe('system2');
    expect(s2.pickCalls[0]?.options).toEqual(options);
    expect(human.ask).not.toHaveBeenCalled();
  });

  it('row 2b: middle band, System 2 disagrees, attended -> human decides', async () => {
    const s2 = new MockChatModel({ pick: () => 'b' });
    const human = fakeHuman({ choice: 'b' });
    const r = await gate(answer('a', 0.65), base({ s2, human: human.hook }));
    expect(r).toMatchObject({ outcome: 'act', choice: 'b' });
    expect(r.record.escalatedTo).toBe('human');
    expect(human.ask).toHaveBeenCalledOnce();
  });

  it('row 2c: middle band, System 2 disagrees, unattended -> blocked', async () => {
    const s2 = new MockChatModel({ pick: () => 'b' });
    const human = fakeHuman();
    const r = await gate(answer('a', 0.65), base({ s2, human: human.hook, attended: false }));
    expect(r.outcome).toBe('blocked');
    expect(r.reason).toMatch(/System 2 chose b/);
    expect(r.record.escalatedTo).toBe('system2');
    expect(human.ask).not.toHaveBeenCalled();
  });

  it('row 2d: middle band without System 2 goes straight to human / blocked', async () => {
    const human = fakeHuman({ choice: 'a' });
    const attended = await gate(answer('a', 0.65), base({ human: human.hook }));
    expect(attended).toMatchObject({ outcome: 'act', choice: 'a' });
    expect(attended.record.escalatedTo).toBe('human');
    const unattended = await gate(answer('a', 0.65), base({ human: human.hook, attended: false }));
    expect(unattended.outcome).toBe('blocked');
    expect(human.ask).toHaveBeenCalledOnce();
  });

  it('row 2e: System 2 failure falls back to human', async () => {
    const s2 = new MockChatModel({
      pick: () => {
        throw new Error('boom');
      },
    });
    const human = fakeHuman({ choice: 'a' });
    const r = await gate(answer('a', 0.65), base({ s2, human: human.hook }));
    expect(r.outcome).toBe('act');
    expect(r.reason).toMatch(/System 2 failed/);
  });

  it('row 3a: below escalate threshold, attended -> asks human with probabilities and reason', async () => {
    const human = fakeHuman({ choice: 'a' });
    const s2 = new MockChatModel();
    const r = await gate(answer('a', 0.3), base({ human: human.hook, s2, screenshot: 'abc' }));
    expect(r).toMatchObject({ outcome: 'act', choice: 'a' });
    expect(r.record.escalatedTo).toBe('human');
    expect(s2.pickCalls).toHaveLength(0);
    expect(human.ask).toHaveBeenCalledWith(
      expect.objectContaining({ options, screenshot: 'abc', reason: expect.stringContaining('escalate') }),
    );
  });

  it('row 3b: below escalate threshold, unattended -> blocked', async () => {
    const human = fakeHuman();
    const r = await gate(answer('a', 0.3), base({ human: human.hook, attended: false }));
    expect(r.outcome).toBe('blocked');
    expect(human.ask).not.toHaveBeenCalled();
  });

  it.each(['stuck', 'blocked'])('row 3c: choice "%s" pauses even at high confidence', async (meta) => {
    const human = fakeHuman({ abort: true });
    const attended = await gate(answer(meta, 0.99), base({ human: human.hook }));
    expect(attended.outcome).toBe('abort');
    expect(attended.record.escalatedTo).toBe('human');
    const unattended = await gate(answer(meta, 0.99), base({ human: human.hook, attended: false }));
    expect(unattended.outcome).toBe('blocked');
    expect(human.ask).toHaveBeenCalledOnce();
  });

  it('row 3d: no choice at all is treated as below threshold', async () => {
    const r = await gate(answer(undefined, 0.9), base({ attended: false }));
    expect(r.outcome).toBe('blocked');
  });

  it('human skip and takeover responses are surfaced', async () => {
    expect((await gate(answer('a', 0.1), base({ human: fakeHuman({ skip: true }).hook }))).outcome).toBe('skip');
    expect((await gate(answer('a', 0.1), base({ human: fakeHuman({ takeover: true }).hook }))).outcome).toBe('takeover');
  });

  it('human unavailable (non-interactive) -> blocked; unknown human choice throws', async () => {
    const unavailable = fakeHuman(new S1PilotError(HUMAN_UNAVAILABLE, 'no tty'));
    expect((await gate(answer('a', 0.1), base({ human: unavailable.hook }))).outcome).toBe('blocked');
    const bad = fakeHuman({ choice: 'zzz' });
    await expect(gate(answer('a', 0.1), base({ human: bad.hook }))).rejects.toMatchObject({ code: 'HUMAN_INVALID_CHOICE' });
  });

  it('row 4a: sensitive action always asks a human even at high confidence', async () => {
    const human = fakeHuman({ choice: 'a' });
    const s2 = new MockChatModel();
    const r = await gate(answer('a', 0.99), base({ human: human.hook, s2, sensitive: { actionClass: 'pay' } }));
    expect(r).toMatchObject({ outcome: 'act', choice: 'a' });
    expect(r.record.escalatedTo).toBe('human');
    expect(r.reason).toMatch(/sensitive action \(pay\)/);
    expect(human.ask).toHaveBeenCalledOnce();
  });

  it('row 4b: sensitive action unattended -> blocked', async () => {
    const human = fakeHuman();
    const r = await gate(answer('a', 0.99), base({ human: human.hook, attended: false, sensitive: { actionClass: 'delete' } }));
    expect(r.outcome).toBe('blocked');
    expect(human.ask).not.toHaveBeenCalled();
  });

  it('row 4c: sensitive action explicitly allowed by the environment acts normally', async () => {
    const human = fakeHuman();
    const r = await gate(answer('a', 0.95), base({ human: human.hook, sensitive: { actionClass: 'send', allowed: true } }));
    expect(r).toMatchObject({ outcome: 'act', choice: 'a' });
    expect(human.ask).not.toHaveBeenCalled();
  });

  it('disagreement flag forces the middle band even with confidence >= act', async () => {
    const s2 = new MockChatModel({ pick: () => 'a' });
    const r = await gate(answer('a', 0.95), base({ s2, disagreement: true }));
    expect(s2.pickCalls).toHaveLength(1);
    expect(r.record.escalatedTo).toBe('system2');
  });
});

describe('gate: unattended runs', () => {
  it('never awaits a human and returns blocked with a reason', async () => {
    const human = fakeHuman();
    const s2 = new MockChatModel({ pick: () => 'b' });
    const cases: { a: DecideAnswer; extra: Partial<GateOptions> }[] = [
      { a: answer('a', 0.1), extra: {} },
      { a: answer('stuck', 0.9), extra: {} },
      { a: answer('a', 0.65), extra: { s2 } },
      { a: answer('a', 0.65), extra: {} },
      { a: answer('a', 0.99), extra: { sensitive: { actionClass: 'pay' } } },
      { a: answer('a', 0.99), extra: { disagreement: true, s2 } },
    ];
    for (const c of cases) {
      const r = await gate(c.a, base({ human: human.hook, attended: false, ...c.extra }));
      expect(r.outcome).toBe('blocked');
      expect(r.reason.length).toBeGreaterThan(0);
      expect(r.record.questionId).toBe('q1');
    }
    expect(human.ask).not.toHaveBeenCalled();
  });
});

describe('gate: option ids are matched as own keys only', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'a model choice of %s is not a valid option and goes to the human',
    async (bad) => {
      const human = fakeHuman({ choice: 'b' });
      const result = await gate(answer(bad, 0.99), base({ human: human.hook }));
      expect(result.outcome).toBe('act'); // the human picked b, not the bogus id
      expect(result).toMatchObject({ choice: 'b' });
      expect(human.ask).toHaveBeenCalledOnce();
    },
  );

  it.each(['constructor', 'toString'])('a human choice of %s is rejected', async (bad) => {
    const human = fakeHuman({ choice: bad });
    await expect(gate(answer('a', 0.3), base({ human: human.hook }))).rejects.toMatchObject({ code: 'HUMAN_INVALID_CHOICE' });
  });
});

describe('gate: calibration (S-058)', () => {
  it('gates on the calibrated confidence and records the raw output next to it', async () => {
    const calibrated: DecideAnswer = {
      ...answer('a', 0.7),
      raw: { probabilities: { a: 0.95, b: 0.02, c: 0.02, stuck: 0.01 }, confidence: 0.95 },
    };
    const result = await gate(calibrated, base({ attended: false }));
    // 0.95 raw would have acted; the calibrated 0.7 is below `act`, so the gate does not act on it.
    expect(result.outcome).not.toBe('act');
    expect(result.record.confidence).toBe(0.7);
    expect(result.record.raw?.confidence).toBe(0.95);
  });
});
