import { readFileSync } from 'node:fs';

import type { DecideRequest, ModelEndpoint } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { loadProfile } from '../profiles.js';
import { createDecisionModel } from '../registry.js';
import { json, serve, servers } from '../test-http.js';

import { createSystemOneModel } from './systemone.js';

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/systemone/${name}`, import.meta.url), 'utf8');

const endpoint = (baseUrl: string): ModelEndpoint => ({ adapter: 'systemone', baseUrl, model: 'clef-flash' });

const request: DecideRequest = {
  state: { url: '/cart', title: 'Cart' },
  questions: {
    next_action: { type: 'choice', instructions: 'Which element?', criteria: { e1: 'Home', e2: 'Cart', e3: 'Checkout', e4: 'Help', e5: 'Back' } },
    step_done: { type: 'noul', instructions: 'Done?' },
    blocked: { type: 'noul', instructions: 'Blocked?' },
  },
};

describe('systemone adapter: success', () => {
  it('answers a 3-question request from a recorded response, in a single call', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 200, fixture('three-questions.json')));
    const model = createDecisionModel(endpoint(baseUrl), { apiKey: 'sk-test-key-0123456789abcdef' });
    const out = await model.decide(request);

    expect(requests).toHaveLength(1);
    expect(Object.keys(out)).toEqual(['next_action', 'step_done', 'blocked']);
    for (const answer of Object.values(out)) {
      const sum = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    }
    expect(out['next_action']).toMatchObject({ choice: 'e3' });
    expect(out['next_action']?.confidence).toBeCloseTo(0.9012, 3);
    expect(out['step_done']).toMatchObject({ noul: 0.12 });
    expect(out['step_done']?.confidence).toBeCloseTo(0.88);
    expect(out['blocked']?.noul).toBeCloseTo(0.03);
  });

  it('sends POST /v1/systemone with model, state and questions 1:1, plus the bearer token', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 200, fixture('three-questions.json')));
    await createDecisionModel(endpoint(`${baseUrl}/`), { apiKey: 'sk-test-key-0123456789abcdef' }).decide(request);
    const [sent] = requests;
    expect(sent).toMatchObject({ method: 'POST', url: '/v1/systemone' });
    expect(sent?.headers['authorization']).toBe('Bearer sk-test-key-0123456789abcdef');
    expect(sent?.body).toEqual({ model: 'clef-flash', state: request.state, questions: request.questions });
  });

  it('uses a base URL that already ends in /decisions as the endpoint (OpenRouter)', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 200, fixture('three-questions.json')));
    await createDecisionModel(endpoint(`${baseUrl}/api/alpha/decisions`)).decide(request);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/alpha/decisions' });
  });

  it('sends no Authorization header without an API key', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 200, fixture('three-questions.json')));
    await createDecisionModel(endpoint(baseUrl)).decide(request);
    expect(requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('accepts a bare answers object, score distributions, and ignores unknown fields', async () => {
    const { baseUrl } = await serve((_, res) => json(res, 200, fixture('score-bare.json')));
    const out = await createDecisionModel(endpoint(baseUrl)).decide({
      state: {},
      questions: { quality: { type: 'score', instructions: 'Rate', criteria: ['low', 'medium', 'high'] } },
    });
    expect(out['quality']).toMatchObject({ score: 2, confidence: 0.7 });
  });
});

describe('systemone adapter: images', () => {
  const withImage: DecideRequest = { ...request, images: [{ mediaType: 'image/png', data: 'AAAA' }] };
  const clef = loadProfile('clef');

  it('omits images when the model does not support them', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 200, fixture('three-questions.json')));
    await createDecisionModel(endpoint(baseUrl)).decide(withImage);
    expect(requests[0]?.body).not.toHaveProperty('images');
  });

  it('sends base64 images with their media type when supported', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 200, fixture('three-questions.json')));
    const model = createSystemOneModel({
      endpoint: endpoint(baseUrl),
      profile: { ...clef, capabilities: { ...clef.capabilities, supportsImages: true } },
      options: {},
    });
    await model.decide(withImage);
    expect(requests[0]?.body['images']).toEqual([{ media_type: 'image/png', data: 'AAAA' }]);
  });
});

describe('systemone adapter: fan-out for single-question profiles', () => {
  it('sends one question per call and merges the answers', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 200, fixture('three-questions.json')));
    const clef = loadProfile('clef');
    const model = createSystemOneModel({
      endpoint: endpoint(baseUrl),
      profile: { ...clef, capabilities: { ...clef.capabilities, multiQuestionPerCall: false } },
      options: {},
    });
    const out = await model.decide(request);
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => Object.keys(r.body['questions'] as object))).toEqual(
      expect.arrayContaining([['next_action'], ['step_done'], ['blocked']]),
    );
    expect(Object.keys(out)).toEqual(['next_action', 'step_done', 'blocked']);
  });
});

describe('systemone adapter: errors', () => {
  it('maps 401 to MODEL_HTTP without retrying, hiding the key from the snippet', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 401, '{"error":"bad key sk-test-key-0123456789abcdef"}'));
    const model = createDecisionModel(endpoint(baseUrl), { apiKey: 'sk-test-key-0123456789abcdef', retryDelayMs: 0 });
    const error = await model.decide(request).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MODEL_HTTP', details: { status: 401 } });
    expect(JSON.stringify(error)).not.toContain('sk-test-key');
    expect(requests).toHaveLength(1);
  });

  it('retries a 500 once and succeeds', async () => {
    const { baseUrl, requests } = await serve((n, res) => (n === 1 ? json(res, 500, 'oops') : json(res, 200, fixture('three-questions.json'))));
    const out = await createDecisionModel(endpoint(baseUrl), { retryDelayMs: 0 }).decide(request);
    expect(requests).toHaveLength(2);
    expect(out['next_action']?.choice).toBe('e3');
  });

  it('gives up after one retry on a persistent 500', async () => {
    const { baseUrl, requests } = await serve((_, res) => json(res, 503, 'down'));
    await expect(createDecisionModel(endpoint(baseUrl), { retryDelayMs: 0 }).decide(request)).rejects.toMatchObject({
      code: 'MODEL_HTTP',
      details: { status: 503 },
    });
    expect(requests).toHaveLength(2);
  });

  it('retries a connection failure once, then reports MODEL_NETWORK', async () => {
    const { baseUrl } = await serve((_, res) => json(res, 200, '{}'));
    servers.pop()?.close(); // port is now dead
    await expect(createDecisionModel(endpoint(baseUrl), { retryDelayMs: 0 }).decide(request)).rejects.toMatchObject({
      code: 'MODEL_NETWORK',
    });
  });

  it('times out slow servers with MODEL_TIMEOUT', async () => {
    const { baseUrl } = await serve(() => undefined); // never answers
    await expect(createDecisionModel(endpoint(baseUrl), { timeoutMs: 50 }).decide(request)).rejects.toMatchObject({
      code: 'MODEL_TIMEOUT',
    });
  });

  describe('malformed responses → MODEL_BAD_RESPONSE with a redacted, truncated snippet', () => {
    const cases: [string, string][] = [
      ['not JSON', '<html>502 Bad Gateway for jane@example.com</html>'],
      ['wrong shape', '{"answers": "nope"}'],
      ['missing question', '{"answers":{"next_action":{"choice":"e3","probabilities":{"e3":1}}}}'],
      ['invalid probability', '{"answers":{"next_action":{"probabilities":{"e3":-1}},"step_done":{"noul":0.5},"blocked":{"noul":0.5}}}'],
      ['unknown option', '{"answers":{"next_action":{"probabilities":{"zzz":1}},"step_done":{"noul":0.5},"blocked":{"noul":0.5}}}'],
      ['noul out of range', '{"answers":{"next_action":{"choice":"e1","probabilities":{"e1":1}},"step_done":{"noul":7},"blocked":{"noul":0.5}}}'],
    ];

    it.each(cases)('%s', async (_name, body) => {
      const { baseUrl, requests } = await serve((_, res) => json(res, 200, body));
      const error = (await createDecisionModel(endpoint(baseUrl), { retryDelayMs: 0 }).decide(request).catch((e: unknown) => e)) as {
        code: string;
        details: { snippet: string };
      };
      expect(error.code).toBe('MODEL_BAD_RESPONSE');
      expect(typeof error.details.snippet).toBe('string');
      expect(error.details.snippet).not.toContain('jane@example.com');
      expect(requests).toHaveLength(1);
    });

    it('truncates the snippet to 500 characters (plus an ellipsis)', async () => {
      const { baseUrl } = await serve((_, res) => json(res, 200, `not json ${'x'.repeat(5000)}`));
      const error = (await createDecisionModel(endpoint(baseUrl)).decide(request).catch((e: unknown) => e)) as {
        details: { snippet: string };
      };
      expect(error.details.snippet).toHaveLength(501);
      expect(error.details.snippet.endsWith('…')).toBe(true);
    });
  });
});
