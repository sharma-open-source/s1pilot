import {
  S1PilotError,
  type AdapterKind,
  type Capabilities,
  type DecideRequest,
  type ModelEndpoint,
  type ProbeResult,
  type Profile,
} from '@s1pilot/domain';

import { listProfiles } from './profiles.js';
import { createChatModel, createDecisionModel, type CreateModelOptions } from './registry.js';
import { isCloudEndpoint } from './util/endpoint.js';
import { joinUrl, safeSnippet } from './util/http.js';

export interface ProbeTarget {
  baseUrl: string;
  /** Model name; looked up from `/v1/models` when omitted. */
  model?: string;
  apiKey?: string;
  /** `'auto'` (default) tries `systemone` → `decide` → `openai-logprobs` → `openai-chat`. */
  adapter?: AdapterKind | 'auto';
}

export interface ProbeOptions {
  fetch?: typeof fetch;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Timed calls used for the latency median. Default 3. */
  samples?: number;
}

const AUTO_ORDER: AdapterKind[] = ['systemone', 'decide', 'openai-logprobs', 'openai-chat'];

/** 1×1 transparent PNG used for the image-support check. */
const PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Used when neither the server nor a profile says anything. Deliberately conservative. */
const CONSERVATIVE: Capabilities = {
  maxOptions: 16,
  multiQuestionPerCall: false,
  supportsImages: false,
  maxContextTokens: 4096,
  orderSensitive: true,
};

const CANNED: DecideRequest = {
  state: { page: 'Profile form', elements: ['link "Home"', 'button "Save"', 'link "Help"'] },
  questions: {
    pick: {
      type: 'choice',
      instructions: 'Which element saves the form?',
      criteria: { e1: 'link "Home"', e2: 'button "Save"', e3: 'link "Help"' },
    },
    ready: { type: 'noul', instructions: 'Is this page a form?' },
  },
};

function median(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] as number;
}

/** Longest profile id contained in the model name wins (`clef-flash` over `clef`). */
function matchProfile(model: string, profiles: Profile[]): Profile | undefined {
  const name = model.toLowerCase();
  return profiles
    .filter((p) => name.includes(p.id) || name.includes(p.name.toLowerCase()))
    .sort((a, b) => b.id.length - a.id.length)[0];
}

interface ServerMeta {
  models: { id: string; contextTokens?: number }[];
}

/** Best-effort `GET /v1/models`. Network failures and timeouts propagate; every other failure means "no metadata". */
async function fetchMeta(target: ProbeTarget, opts: Required<Pick<ProbeOptions, 'timeoutMs'>> & ProbeOptions): Promise<ServerMeta> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(joinUrl(target.baseUrl, '/v1/models'), {
      headers: { accept: 'application/json', ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}) },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new S1PilotError('MODEL_TIMEOUT', `The server did not answer within ${opts.timeoutMs} ms`);
    }
    throw new S1PilotError('MODEL_NETWORK', 'Could not connect to the server');
  }
  if (response.status === 401 || response.status === 403) {
    throw new S1PilotError('MODEL_HTTP', 'Authentication failed', { status: response.status });
  }
  if (!response.ok) return { models: [] };
  try {
    const body = (await response.json()) as { data?: { id?: unknown; max_model_len?: unknown }[] };
    const models = (body.data ?? []).flatMap((m) =>
      typeof m.id === 'string'
        ? [{ id: m.id, ...(typeof m.max_model_len === 'number' ? { contextTokens: m.max_model_len } : {}) }]
        : [],
    );
    return { models };
  } catch {
    return { models: [] };
  }
}

/** Describes a connection failure for people, never including URLs' credentials or keys. */
function describeFailure(error: unknown, baseUrl: string): string {
  if (error instanceof S1PilotError) {
    if (error.code === 'MODEL_NETWORK') return `Could not connect to ${baseUrl}. Is the server running and the URL correct?`;
    if (error.code === 'MODEL_TIMEOUT') return `${baseUrl} did not answer in time. Check the URL and that the server is reachable.`;
    const status = error.details?.['status'];
    if (status === 401 || status === 403) return `The server rejected the API key (HTTP ${status}). Check the key.`;
    return error.message;
  }
  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * Detects which adapter a server speaks, its capabilities and latency.
 * Never throws: failures come back as `{ ok: false, error }` (unreachable hosts within one request timeout).
 * Capabilities come from server metadata (`/v1/models`) where available, else the profile matching the model name,
 * else conservative defaults (`maxOptions: 16`).
 */
export async function probe(target: ProbeTarget, options: ProbeOptions = {}): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const sampleCount = options.samples ?? 3;
  const isCloud = isCloudEndpoint(target.baseUrl);
  const warnings: string[] = [];
  const fail = (error: string): ProbeResult => ({
    ok: false,
    latencyMs: { p50: 0, samples: [] },
    isCloud,
    warnings,
    error,
  });
  if (isCloud) warnings.push('This endpoint is outside your network: page text and screenshots sent to it leave your machine.');

  try {
    const meta = await fetchMeta(target, { ...options, timeoutMs });
    const model = target.model ?? meta.models[0]?.id ?? 'default';
    if (target.model === undefined) {
      warnings.push(
        meta.models[0] ? `No model given; using "${model}" reported by the server.` : 'No model given and the server lists none; using "default".',
      );
    }

    const profile = matchProfile(model, listProfiles());
    if (profile) warnings.push(`Capabilities taken from the "${profile.id}" profile (matched by model name).`);
    const contextTokens = meta.models.find((m) => m.id === model)?.contextTokens;

    const modelOptions: CreateModelOptions = {
      timeoutMs,
      retries: 0,
      ...(target.apiKey ? { apiKey: target.apiKey } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
    const endpointFor = (adapter: AdapterKind): ModelEndpoint => ({
      adapter,
      baseUrl: target.baseUrl,
      model,
      ...(profile ? { profileId: profile.id } : {}),
    });

    // 1. Detect the adapter.
    const candidates = target.adapter === undefined || target.adapter === 'auto' ? AUTO_ORDER : [target.adapter];
    let detected: AdapterKind | undefined;
    const notes: string[] = [];
    for (const adapter of candidates) {
      try {
        await attempt(adapter);
        detected = adapter;
        break;
      } catch (error) {
        if (error instanceof S1PilotError && (error.code === 'MODEL_NETWORK' || error.code === 'MODEL_TIMEOUT')) throw error;
        const status = error instanceof S1PilotError ? error.details?.['status'] : undefined;
        if (status === 401 || status === 403) throw error;
        notes.push(`${adapter}: ${error instanceof Error ? error.message : 'failed'}`);
      }
    }
    if (!detected) {
      warnings.push(...notes);
      return fail(`No supported model API found at ${target.baseUrl} (tried ${candidates.join(', ')}).`);
    }

    async function attempt(adapter: AdapterKind): Promise<void> {
      if (adapter === 'openai-chat') {
        const chat = createChatModel(endpointFor(adapter), modelOptions);
        const reply = await chat.chat({ messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxTokens: 8 });
        if (reply.text.trim() === '') throw new S1PilotError('MODEL_BAD_RESPONSE', 'empty reply');
        return;
      }
      await createDecisionModel(endpointFor(adapter), modelOptions).decide(CANNED);
    }

    // 2. Capabilities.
    const base = profile?.capabilities ?? CONSERVATIVE;
    const capabilities: Capabilities = {
      ...base,
      ...(contextTokens !== undefined ? { maxContextTokens: contextTokens } : {}),
      // Only the systemone endpoint takes several questions per call.
      multiQuestionPerCall: detected === 'systemone' && (profile ? base.multiQuestionPerCall : true),
    };
    if (!profile) warnings.push('Unknown model: using conservative defaults (16 options). Run the calibration or pick a profile.');
    if (detected === 'openai-chat') {
      warnings.push('This endpoint is a chat model: usable as System 2, not as a System 1 decision model.');
    }

    // 3. Latency: median of timed calls.
    const samples: number[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const started = performance.now();
      await attempt(detected);
      samples.push(Math.round(performance.now() - started));
    }

    // 4. Image support, only when the profile claims it.
    if (capabilities.supportsImages && detected !== 'openai-chat') {
      try {
        await createDecisionModel(endpointFor(detected), modelOptions).decide({
          ...CANNED,
          images: [{ mediaType: 'image/png', data: PIXEL_PNG }],
        });
      } catch {
        capabilities.supportsImages = false;
        warnings.push('The profile says images are supported, but a test call with an image failed; images disabled.');
      }
    }

    return { ok: true, adapter: detected, model, capabilities, latencyMs: { p50: median(samples), samples }, isCloud, warnings };
  } catch (error) {
    return fail(describeFailure(error, target.baseUrl) + (error instanceof S1PilotError && error.details?.['snippet'] ? ` (${safeSnippet(String(error.details['snippet']), target.apiKey ? [target.apiKey] : [])})` : ''));
  }
}
