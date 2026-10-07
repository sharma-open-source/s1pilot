import { ProbeResultSchema } from '@s1pilot/domain';
import { describe, expect, it } from 'vitest';

import { probe } from './probe.js';
import { json, serve, servers, type Recorded } from './test-http.js';

type Kind = 'systemone' | 'decide' | 'logprobs' | 'chat';

interface Fake {
  models?: unknown;
  /** Reject any request that carries images with HTTP 400. */
  rejectImages?: boolean;
  /** Require this bearer token, else 401. */
  token?: string;
}

const completion = (token: string) =>
  JSON.stringify({
    choices: [{ message: { content: token }, logprobs: { content: [{ token, logprob: Math.log(0.9), top_logprobs: [{ token, logprob: Math.log(0.9) }, { token: token === 'A' ? 'B' : 'No', logprob: Math.log(0.1) }] }] } }],
  });

/** A fake model server that speaks exactly one wire format; it answers based on the most recent recorded request. */
async function server(kind: Kind, options: Fake = {}) {
  const ctx = await serve((_, res) => {
    const req = ctx.requests.at(-1) as Recorded;
    if (options.token && req.headers['authorization'] !== `Bearer ${options.token}`) return json(res, 401, '{"error":"unauthorized"}');
    if (req.method === 'GET' && req.url === '/v1/models') {
      return options.models ? json(res, 200, JSON.stringify(options.models)) : json(res, 404, 'nope');
    }
    if (options.rejectImages && 'images' in req.body) return json(res, 400, 'images not supported');

    if (kind === 'systemone' && req.url === '/v1/systemone') {
      const questions = req.body['questions'] as Record<string, { type: string; criteria?: Record<string, string> }>;
      const answers = Object.fromEntries(
        Object.entries(questions).map(([id, q]) => [id, q.type === 'choice' ? { probabilities: { e2: 0.8, e1: 0.1, e3: 0.1 } } : { noul: 0.7 }]),
      );
      return json(res, 200, JSON.stringify({ answers }));
    }
    if (kind === 'decide' && req.url === '/v1/decide') {
      const kindOf = (req.body['question'] as { kind: string }).kind;
      return json(res, 200, kindOf === 'choice' ? '{"probabilities":{"e2":0.8,"e1":0.1,"e3":0.1}}' : '{"noul":0.7}');
    }
    if ((kind === 'logprobs' || kind === 'chat') && req.url === '/v1/chat/completions') {
      if (kind === 'chat') return json(res, 200, JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
      const user = ((req.body['messages'] as { content: string }[])[1]?.content ?? '') as string;
      return json(res, 200, completion(user.includes('Options:\nyes') ? 'Yes' : 'A'));
    }
    json(res, 404, '{"error":"not found"}');
  });
  return ctx;
}

describe('probe: auto-detect', () => {
  it.each([
    ['systemone', 'systemone'],
    ['decide', 'decide'],
    ['logprobs', 'openai-logprobs'],
    ['chat', 'openai-chat'],
  ] as const)('a %s server is detected as %s', async (kind, adapter) => {
    const { baseUrl } = await server(kind);
    const result = await probe({ baseUrl, model: 'my-model' });
    expect(result).toMatchObject({ ok: true, adapter, model: 'my-model', isCloud: false });
    expect(result.latencyMs.samples).toHaveLength(3);
    expect(result.latencyMs.p50).toBe([...result.latencyMs.samples].sort((a, b) => a - b)[1]);
    expect(ProbeResultSchema.safeParse(result).success).toBe(true);
  });

  it('tries adapters in order and stops at the first that works', async () => {
    const { baseUrl, requests } = await server('systemone');
    await probe({ baseUrl, model: 'm' });
    const posts = requests.filter((r) => r.method === 'POST').map((r) => r.url);
    expect(new Set(posts)).toEqual(new Set(['/v1/systemone']));

    const decide = await server('decide');
    await probe({ baseUrl: decide.baseUrl, model: 'm' });
    expect(decide.requests.filter((r) => r.method === 'POST')[0]?.url).toBe('/v1/systemone'); // tried first, got 404
    expect(decide.requests.some((r) => r.url === '/v1/decide')).toBe(true);
  });

  it('honours an explicit adapter, and fails when the server does not speak it', async () => {
    const { baseUrl } = await server('decide');
    expect((await probe({ baseUrl, model: 'm', adapter: 'decide' })).adapter).toBe('decide');

    const other = await server('decide');
    const wrong = await probe({ baseUrl: other.baseUrl, model: 'm', adapter: 'systemone' });
    expect(wrong).toMatchObject({ ok: false, error: expect.stringContaining('No supported model API') });
    expect(new Set(other.requests.filter((r) => r.method === 'POST').map((r) => r.url))).toEqual(new Set(['/v1/systemone']));
    expect(ProbeResultSchema.safeParse(wrong).success).toBe(true);
  });

  it('reports a chat-only server as System 2 only', async () => {
    const { baseUrl } = await server('chat');
    const result = await probe({ baseUrl, model: 'gpt-x' });
    expect(result.warnings.join(' ')).toContain('System 2');
  });

  it('sends the API key as a bearer token, and reports a rejected key clearly without trying other adapters', async () => {
    const good = await server('systemone', { token: 'sk-secret-key-0123456789abcdef' });
    expect((await probe({ baseUrl: good.baseUrl, model: 'm', apiKey: 'sk-secret-key-0123456789abcdef' })).ok).toBe(true);

    const denied = await server('systemone', { token: 'sk-secret-key-0123456789abcdef' });
    const result = await probe({ baseUrl: denied.baseUrl, model: 'm', apiKey: 'sk-wrong-key-0123456789abcdef' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('rejected the API key') });
    expect(JSON.stringify(result)).not.toContain('sk-wrong-key');
    expect(denied.requests.some((r) => r.url === '/v1/decide')).toBe(false);
  });

  it('fails with a readable message when no adapter matches', async () => {
    const { baseUrl } = await serve((_, res) => json(res, 404, 'nothing here'));
    const result = await probe({ baseUrl, model: 'm' });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('tried systemone, decide, openai-logprobs, openai-chat') });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('probe: failures are fast and readable', () => {
  it('an unreachable URL gives ok:false with a human-readable error well within 5 s', async () => {
    const { baseUrl } = await serve((_, res) => json(res, 200, '{}'));
    servers.pop()?.close(); // port is now dead
    const started = performance.now();
    const result = await probe({ baseUrl });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Could not connect') });
    expect(ProbeResultSchema.safeParse(result).success).toBe(true);
  });

  it('a server that never answers times out instead of hanging', async () => {
    const { baseUrl } = await serve(() => undefined);
    const started = performance.now();
    const result = await probe({ baseUrl }, { timeoutMs: 150 });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('did not answer in time') });
  });
});

describe('probe: capabilities', () => {
  it('uses the profile matched by model name (longest id wins)', async () => {
    const { baseUrl } = await server('decide');
    const jev9 = await probe({ baseUrl, model: 'autotrust/JEV-9B-instruct' });
    expect(jev9.capabilities).toMatchObject({ maxOptions: 256, multiQuestionPerCall: false, supportsImages: false });
    expect(jev9.warnings.join(' ')).toContain('"jev-9b" profile');

    const flash = await server('systemone');
    const clef = await probe({ baseUrl: flash.baseUrl, model: 'Cloudflare/clef-flash' });
    expect(clef.warnings.join(' ')).toContain('"clef-flash" profile');
    expect(clef.capabilities).toMatchObject({ maxOptions: 64, multiQuestionPerCall: true });
  });

  it('falls back to conservative defaults (16 options) for unknown models', async () => {
    const { baseUrl } = await server('systemone');
    const result = await probe({ baseUrl, model: 'totally-unknown' });
    expect(result.capabilities).toMatchObject({ maxOptions: 16, supportsImages: false, orderSensitive: true, multiQuestionPerCall: true });
    expect(result.warnings.join(' ')).toContain('conservative defaults');
  });

  it('reads the model and context size from /v1/models when available', async () => {
    const { baseUrl } = await server('logprobs', { models: { data: [{ id: 'my-vllm-model', max_model_len: 12288 }] } });
    const result = await probe({ baseUrl });
    expect(result).toMatchObject({ ok: true, model: 'my-vllm-model' });
    expect(result.capabilities?.maxContextTokens).toBe(12288);
    expect(result.warnings.join(' ')).toContain('reported by the server');
  });

  it('warns about cloud endpoints', async () => {
    const stub = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    const result = await probe({ baseUrl: 'https://models.example.com', model: 'm' }, { fetch: stub });
    expect(result.isCloud).toBe(true);
    expect(result.warnings.join(' ')).toContain('outside your network');
  });
});

describe('probe: image support', () => {
  it('sends a 1x1 PNG when the profile claims image support and keeps the flag when it works', async () => {
    const { baseUrl, requests } = await server('decide');
    const result = await probe({ baseUrl, model: 'autotrust/JEV-27B-VL', adapter: 'decide' });
    expect(result.capabilities?.supportsImages).toBe(true);
    const withImages = requests.filter((r) => 'images' in r.body);
    expect(withImages.length).toBeGreaterThan(0);
    expect(JSON.stringify(withImages[0]?.body['images'])).toContain('image/png');
  });

  it('disables image support with a warning when the test call fails', async () => {
    const { baseUrl } = await server('decide', { rejectImages: true });
    const result = await probe({ baseUrl, model: 'autotrust/JEV-27B-VL', adapter: 'decide' });
    expect(result).toMatchObject({ ok: true, capabilities: { supportsImages: false } });
    expect(result.warnings.join(' ')).toContain('images disabled');
  });

  it('skips the image test for text-only profiles', async () => {
    const { baseUrl, requests } = await server('decide');
    await probe({ baseUrl, model: 'jev-9b' });
    expect(requests.some((r) => 'images' in r.body)).toBe(false);
  });
});
