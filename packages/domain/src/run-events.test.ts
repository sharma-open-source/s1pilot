import { describe, expect, it } from 'vitest';

import { DecideAnswerSchema, QuestionSchema } from './decision.js';
import { RunEventSchema } from './events.js';

const base = { runId: 'r1', ts: '2026-01-01T00:00:00.000Z' };
const step = { ...base, caseResultId: 'cr1', stepIndex: 0 };

describe('RunEventSchema', () => {
  const events = [
    { type: 'run.started', ...base, totalCases: 3 },
    { type: 'case.started', ...base, caseResultId: 'cr1', caseId: 'c1' },
    { type: 'step.started', ...step, action: 'click' },
    {
      type: 'decision.made',
      ...step,
      decision: {
        questionId: 'next_action',
        options: ['e1', 'e2'],
        probabilities: { e1: 0.9, e2: 0.1 },
        chosen: 'e1',
        confidence: 0.9,
        model: 'mock',
        latencyMs: 12,
      },
    },
    { type: 'assertion.verdict', ...step, verdict: { assertion: 'ai', verdict: 'pass', probability: 0.95 } },
    {
      type: 'escalation.needed',
      ...step,
      escalationId: 'x1',
      reason: 'low-confidence',
      to: 'human',
    },
    { type: 'escalation.resolved', ...base, escalationId: 'x1', resolution: 'approved', by: 'human' },
    { type: 'step.finished', ...step, status: 'passed', durationMs: 5 },
    { type: 'case.finished', ...base, caseResultId: 'cr1', verdict: 'passed', durationMs: 50 },
    { type: 'run.finished', ...base, status: 'finished', summary: {} },
    { type: 'log', ...base, level: 'info', message: 'hello' },
  ];

  it.each(events.map((e) => [e.type, e] as const))('parses %s', (_type, event) => {
    expect(RunEventSchema.safeParse(event).success).toBe(true);
  });

  it('discriminates on type and rejects unknown types', () => {
    const result = RunEventSchema.safeParse({ type: 'nope', ...base });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('invalid_union_discriminator');
  });

  it('rejects a malformed timestamp', () => {
    expect(RunEventSchema.safeParse({ type: 'log', ...base, ts: 'yesterday', level: 'info', message: 'x' }).success).toBe(false);
  });
});

describe('decision contract', () => {
  it('parses the three question kinds', () => {
    expect(QuestionSchema.safeParse({ type: 'noul', instructions: 'Is it done?' }).success).toBe(true);
    expect(QuestionSchema.safeParse({ type: 'choice', instructions: 'Pick', criteria: { e1: 'Buy' } }).success).toBe(true);
    expect(QuestionSchema.safeParse({ type: 'score', instructions: 'Rate', criteria: ['low', 'high'] }).success).toBe(true);
    expect(QuestionSchema.safeParse({ type: 'choice', instructions: 'Pick' }).success).toBe(false);
  });

  it('parses an answer and rejects out-of-range probabilities', () => {
    expect(DecideAnswerSchema.safeParse({ choice: 'e1', probabilities: { e1: 1 }, confidence: 1 }).success).toBe(true);
    expect(DecideAnswerSchema.safeParse({ probabilities: { e1: 1.5 }, confidence: 1 }).success).toBe(false);
  });
});
