import type { DecideRequest, ModelEndpoint, Question } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { loadProfile } from '../profiles.js';
import { createDecisionModel } from '../registry.js';
import { json, serve } from '../test-http.js';

import { createDecideModel, toDecideQuestion } from './decide.js';

const endpoint = (baseUrl: string, extra: Partial<ModelEndpoint> = {}): ModelEndpoint => ({
  adapter: 'decide',
  baseUrl,
  model: 'jev-9b',
  ...extra,
});

const request: DecideRequest = {
  state: { url: '/cart' },
  questions: {
    next_action: { type: 'choice', instructions: 'Which element?', criteria: { e1: 'Home', e2: 'Checkout' } },
    step_done: { type: 'noul', instructions: 'Done?' },
    quality: { type: 'score', instructions: 'Rate', criteria: ['low', 'mid', 'high'] },
  },
};

/** Answers each single-question call according to the question kind it received. */
function answerByKind(body: Record<string, unknown>): string {
  const question = body['question'] as { kind: string; options?: { id: string }[]; levels?: string[] };
  if (question.kind === 'choice') {
    const [first, ...rest] = question.options ?? [];
    const probabilities = Object.fromEntries([[first?.id, 0.9], ...rest.map((o) => [o.id, 0.1 / rest.length])]);
    return JSON.stringify({ choice: first?.id, probabilities });
  }
  if (question.kind === 'boolean') return JSON.stringify({ noul: 0.25 });
  return JSON.stringify({ score: 2, probabilities: { low: 0.05, mid: 0.15, high: 0.8 } });
}

describe('toDecideQuestion', () => {
  it('translates the three question types', () => {
    const [choice, noul, score] = Object.values(request.questions) as Question[];
    expect(toDecideQuestion(choice as Question)).toEqual({
      kind: 'choice',
      instructions: 'Which element?',
      options: [{ id: 'e1', text: 'Home' }, { id: 'e2', text: 'Checkout' }],
    });
    expect(toDecideQuestion(noul as Question)).toEqual({ kind: 'boolean', instructions: 'Done?' });
    expect(toDecideQuestion(score as Question)).toEqual({ kind: 'scale', instructions: 'Rate', levels: ['low', 'mid', 'high'] });
  });
});

describe('decide adapter: success', () => {
  it('turns 3 questions into 3 parallel HTTP calls and merges the answers', async () => {
    let inFlight = 0;
    let peak = 0;
    const { baseUrl, requests } = await serve((_, res) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const received = requests.at(-1)?.body ?? {};
      setTimeout(() => {
        inFlight--;
        json(res, 200, answerByKind(received));
      }, 30);
    });
    const body = await createDecisionModel(endpoint(baseUrl), { apiKey: 'sk-test-key-0123456789abcdef' }).decide(request);

    expect(requests).toHaveLength(3);
    expect(peak).toBe(3); // issued in parallel, not one after another
    expect(requests.every((r) => r.method === 'POST' && r.url === '/v1/decide')).toBe(true);
    expect(requests[0]?.headers['authorization']).toBe('Bearer sk-test-key-0123456789abcdef');
    expect(requests.map((r) => (r.body['question'] as { kind: string }).kind).sort()).toEqual(['boolean', 'choice', 'scale']);
    expect(requests.every((r) => r.body['model'] === 'jev-9b' && !('images' in r.body))).toBe(true);

    expect(Object.keys(body)).toEqual(['next_action', 'step_done', 'quality']);
    expect(body['next_action']).toMatchObject({ choice: 'e1', confidence: 0.9 });
    expect(body['step_done']).toMatchObject({ noul: 0.25, confidence: 0.75 });
    expect(body['quality']).toMatchObject({ score: 2, confidence: 0.8 });
  });

  it('declares multiQuestionPerCall: false and keeps the profile limits', () => {
    const model = createDecisionModel(endpoint('http://x.test', { profileId: 'jev' }));
    expect(model.capabilities).toMatchObject({ multiQuestionPerCall: false, maxOptions: 255, supportsImages: true });
    expect(createDecisionModel(endpoint('http://x.test')).capabilities).toMatchObject({ multiQuestionPerCall: false, maxOptions: 256 });
  });

  it('never has more than 4 requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const questions = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`q${i}`, { type: 'noul' as const, instructions: `Q${i}` }]),
    );
    const { baseUrl, requests } = await serve((_, res) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      setTimeout(() => {
        inFlight--;
        json(res, 200, '{"noul":0.5}');
      }, 20);
    });
    const out = await createDecisionModel(endpoint(baseUrl)).decide({ state: {}, questions });
    expect(requests).toHaveLength(10);
    expect(peak).toBe(4);
    expect(Object.keys(out)).toHaveLength(10);
  });

  it('accepts a 256-option choice request', async () => {
    const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`e${i}`, `Option ${i}`]));
    const { baseUrl, requests } = await serve((_, res) => json(res, 200, '{"probabilities":{"e255":3,"e0":1}}'));
    const out = await createDecisionModel(endpoint(baseUrl, { profileId: 'jev' })).decide({
      state: {},
      questions: { pick: { type: 'choice', instructions: 'Pick', criteria } },
    });
    expect((requests[0]?.body['question'] as { options: unknown[] }).options).toHaveLength(256);
    expect(out['pick']).toMatchObject({ choice: 'e255', confidence: 0.75 });
    expect(Object.keys(out['pick']?.probabilities ?? {})).toHaveLength(256);
  });
});

describe('decide adapter: images', () => {
  const withImage: DecideRequest = { ...request, images: [{ mediaType: 'image/jpeg', data: 'QUJD' }] };

  it('sends images on every call when the profile supports them (JEV-27B-VL)', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 200, '{"noul":0.5}'));
    await createDecisionModel(endpoint(baseUrl, { profileId: 'jev' })).decide({ ...withImage, questions: { a: { type: 'noul', instructions: 'A' }, b: { type: 'noul', instructions: 'B' } } });
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => JSON.stringify(r.body['images']) === JSON.stringify([{ media_type: 'image/jpeg', data: 'QUJD' }]))).toBe(true);
  });

  it('omits images for text-only profiles (JEV-9B)', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 200, '{"noul":0.5}'));
    await createDecisionModel(endpoint(baseUrl, { profileId: 'jev-9b' })).decide({ ...withImage, questions: { a: { type: 'noul', instructions: 'A' } } });
    expect(requests[0]?.body).not.toHaveProperty('images');
    expect(loadProfile('jev-9b').capabilities.supportsImages).toBe(false);
  });
});

describe('decide adapter: errors', () => {
  it('retries one failed question once, then succeeds without repeating the others', async () => {
    let failedOnce = false;
    const { baseUrl, requests } = await serve((_, res) => {
      const kind = (requests.at(-1)?.body['question'] as { kind: string }).kind;
      if (kind === 'boolean' && !failedOnce) {
        failedOnce = true;
        return json(res, 500, 'oops');
      }
      json(res, 200, answerByKind(requests.at(-1)?.body ?? {}));
    });
    const out = await createDecisionModel(endpoint(baseUrl), { retryDelayMs: 0 }).decide(request);
    expect(requests).toHaveLength(4); // 3 questions + 1 retry of the failed one
    expect(Object.keys(out)).toEqual(['next_action', 'step_done', 'quality']);
  });

  it('rejects the whole decide() with MODEL_HTTP and the question id when one call still fails after its retry', async () => {
    const { baseUrl, requests } = await serve((_, res) => {
      const kind = (requests.at(-1)?.body['question'] as { kind: string }).kind;
      if (kind === 'boolean') return json(res, 500, 'still broken');
      json(res, 200, answerByKind(requests.at(-1)?.body ?? {}));
    });
    const error = await createDecisionModel(endpoint(baseUrl), { retryDelayMs: 0 }).decide(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MODEL_HTTP', details: { status: 500, questionId: 'step_done' } });
    expect(requests.filter((r) => (r.body['question'] as { kind: string }).kind === 'boolean')).toHaveLength(2); // original + one retry, not retried again by the wrapper
  });

  it('does not retry 4xx and reports the question id', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 401, '{"error":"no"}'));
    const error = await createDecisionModel(endpoint(baseUrl), { retryDelayMs: 0 }).decide({
      state: {},
      questions: { only: { type: 'noul', instructions: 'Q' } },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MODEL_HTTP', details: { status: 401, questionId: 'only' } });
    expect(requests).toHaveLength(1);
  });

  it('reports malformed answers as MODEL_BAD_RESPONSE with a redacted snippet and the question id', async () => {
    const { baseUrl } = await serve((_, res) => json(res, 200, 'not json for jane@example.com'));
    const error = (await createDecisionModel(endpoint(baseUrl)).decide({
      state: {},
      questions: { only: { type: 'noul', instructions: 'Q' } },
    }).catch((e: unknown) => e)) as { code: string; details: { snippet: string; questionId: string } };
    expect(error.code).toBe('MODEL_BAD_RESPONSE');
    expect(error.details.questionId).toBe('only');
    expect(error.details.snippet).not.toContain('jane@example.com');
  });

  it('rejects an answer naming an unknown option', async () => {
    const { baseUrl } = await serve((_, res) => json(res, 200, '{"probabilities":{"zzz":1}}'));
    await expect(
      createDecisionModel(endpoint(baseUrl)).decide({ state: {}, questions: { pick: request.questions['next_action'] as Question } }),
    ).rejects.toMatchObject({ code: 'MODEL_BAD_RESPONSE' });
  });

  it('can be created directly from an adapter context', () => {
    const model = createDecideModel({ endpoint: endpoint('http://x.test'), options: {} });
    expect(model.capabilities.multiQuestionPerCall).toBe(false);
  });
});
