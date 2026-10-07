import type { DecideRequest, DecisionModel, ModelEndpoint } from '@s1pilot/domain';
import { S1PilotError } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { MockChatModel, MockDecisionModel } from './adapters/mock.js';
import { createChatModel, createDecisionModel, registerDecisionAdapter } from './registry.js';
import { isRetryable, withRetry, withTimeout } from './util/guard.js';

const request: DecideRequest = { state: {}, questions: { q: { type: 'noul', instructions: 'Ok?' } } };
const mockEndpoint: ModelEndpoint = { adapter: 'mock', model: 'mock' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withTimeout', () => {
  it('raises MODEL_TIMEOUT and aborts the signal', async () => {
    let aborted = false;
    const call = withTimeout(20, (signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return sleep(200).then(() => 'late');
    });
    await expect(call).rejects.toMatchObject({ code: 'MODEL_TIMEOUT', details: { timeoutMs: 20 } });
    expect(aborted).toBe(true);
  });

  it('passes through results and errors from calls that finish in time', async () => {
    expect(await withTimeout(100, async () => 'fast')).toBe('fast');
    await expect(withTimeout(100, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});

describe('withRetry / isRetryable', () => {
  const http = (status: number) => new S1PilotError('MODEL_HTTP', 'bad', { status });

  it('classifies retryable failures', () => {
    expect(isRetryable(http(503))).toBe(true);
    expect(isRetryable(http(400))).toBe(false);
    expect(isRetryable(new S1PilotError('MODEL_NETWORK', 'down'))).toBe(true);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryable(new S1PilotError('MODEL_TIMEOUT', 't'))).toBe(false);
    expect(isRetryable(new Error('other'))).toBe(false);
  });

  it('retries once on a 5xx and then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      if (++attempts === 1) throw http(502);
      return 'ok';
    }, 1, 0);
    expect([result, attempts]).toEqual(['ok', 2]);
  });

  it('gives up after the retry budget and never retries 4xx', async () => {
    let attempts = 0;
    await expect(withRetry(async () => { attempts++; throw http(500); }, 1, 0)).rejects.toMatchObject({ code: 'MODEL_HTTP' });
    expect(attempts).toBe(2);
    attempts = 0;
    await expect(withRetry(async () => { attempts++; throw http(422); }, 3, 0)).rejects.toMatchObject({ code: 'MODEL_HTTP' });
    expect(attempts).toBe(1);
  });
});

describe('createDecisionModel', () => {
  it('creates a mock model wrapped with timeout and retry, keeping its capabilities', async () => {
    const mock = new MockDecisionModel({ script: [{ match: () => true, answer: { noul: 0.95 } }] });
    const model = createDecisionModel(mockEndpoint, { mock });
    expect(model.capabilities).toEqual(mock.capabilities);
    expect((await model.decide(request))['q']?.noul).toBe(0.95);
    expect(mock.calls).toHaveLength(1);
  });

  it('applies the profile capabilities when profileId is set', () => {
    const model = createDecisionModel({ ...mockEndpoint, profileId: 'laya' });
    expect(model.capabilities.maxOptions).toBe(20);
  });

  it('times out slow adapters with MODEL_TIMEOUT', async () => {
    registerDecisionAdapter('decide', () => ({
      capabilities: new MockDecisionModel().capabilities,
      decide: async () => {
        await sleep(200);
        return {};
      },
    }));
    const model = createDecisionModel({ adapter: 'decide', baseUrl: 'http://x.test', model: 'm' }, { timeoutMs: 20 });
    await expect(model.decide(request)).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
  });

  it('retries a registered adapter once on a 5xx', async () => {
    let calls = 0;
    const flaky: DecisionModel = {
      capabilities: new MockDecisionModel().capabilities,
      decide: async () => {
        if (++calls === 1) throw new S1PilotError('MODEL_HTTP', 'upstream', { status: 503 });
        return { q: { noul: 1, probabilities: { true: 1, false: 0 }, confidence: 1 } };
      },
    };
    registerDecisionAdapter('systemone', () => flaky);
    const model = createDecisionModel({ adapter: 'systemone', baseUrl: 'http://x.test', model: 'm' }, { retryDelayMs: 0 });
    expect((await model.decide(request))['q']?.confidence).toBe(1);
    expect(calls).toBe(2);
  });

  it('reports unregistered adapters and wrong roles', () => {
    expect(() => createDecisionModel({ adapter: 'not-registered' as ModelEndpoint['adapter'], baseUrl: 'http://x.test', model: 'm' })).toThrowError(
      expect.objectContaining({ code: 'ADAPTER_NOT_FOUND' }),
    );
    expect(() => createDecisionModel({ adapter: 'openai-chat', baseUrl: 'http://x.test', model: 'm' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADAPTER_ROLE' }),
    );
    expect(() => createDecisionModel({ ...mockEndpoint, profileId: 'nope' })).toThrowError(
      expect.objectContaining({ code: 'PROFILE_NOT_FOUND' }),
    );
  });
});

describe('createChatModel', () => {
  it('creates the mock chat model (or the injected one)', async () => {
    const injected = new MockChatModel({ fallbackReply: 'hello' });
    expect((await createChatModel(mockEndpoint, { mockChat: injected }).chat({ messages: [] })).text).toBe('hello');
    expect(createChatModel(mockEndpoint)).toBeInstanceOf(MockChatModel);
  });

  it('rejects System 1 adapters and unregistered System 2 adapters', () => {
    expect(() => createChatModel({ adapter: 'decide', baseUrl: 'http://x.test', model: 'm' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADAPTER_ROLE' }),
    );
    expect(() => createChatModel({ adapter: 'mock', model: 'm' }, {})).not.toThrow();
    expect(() => createChatModel({ adapter: 'openai-chat', baseUrl: 'http://x.test', model: 'm' })).not.toThrow();
    expect(() => createChatModel({ adapter: 'not-registered' as ModelEndpoint['adapter'], model: 'm' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ADAPTER_ROLE' }),
    );
  });
});
