import type { Capabilities, DecideAnswer, DecideRequest, DecisionModel } from '@s1pilot/domain';
import { z } from 'zod';

import type { AdapterContext } from '../registry.js';
import { fanOut } from '../util/fanout.js';
import { badResponse, joinUrl, postJson } from '../util/http.js';
import { normalizeAnswer } from '../util/normalize.js';
import { AnswerWireSchema } from '../util/wire.js';

/** Used when the endpoint has no `profileId`. */
export const SYSTEMONE_DEFAULT_CAPABILITIES: Capabilities = {
  maxOptions: 64,
  multiQuestionPerCall: true,
  supportsImages: false,
  maxContextTokens: 8192,
  orderSensitive: false,
};

const AnswersWireSchema = z.record(AnswerWireSchema);

/**
 * Creates the model for `POST {baseUrl}/v1/systemone` (Clef, Laya via `laya-serve`, TypeSafe Jev).
 * Wire format: see `systemone.md`.
 */
export function createSystemOneModel(ctx: AdapterContext): DecisionModel {
  const { endpoint, options } = ctx;
  const capabilities = ctx.profile?.capabilities ?? SYSTEMONE_DEFAULT_CAPABILITIES;
  const url = joinUrl(endpoint.baseUrl ?? '', '/v1/systemone');
  const secrets = options.apiKey ? [options.apiKey] : [];

  async function callOnce(req: DecideRequest): Promise<Record<string, DecideAnswer>> {
    const body = {
      model: endpoint.model,
      state: req.state,
      ...(capabilities.supportsImages && req.images && req.images.length > 0
        ? { images: req.images.map((image) => ({ media_type: image.mediaType, data: image.data })) }
        : {}),
      questions: req.questions,
    };
    const text = await postJson({
      adapter: 'systemone',
      url,
      body,
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw badResponse('systemone', 'response is not valid JSON', text, secrets);
    }
    const wrapped = (json as { answers?: unknown } | null)?.answers;
    const parsed = AnswersWireSchema.safeParse(wrapped !== undefined && typeof wrapped === 'object' ? wrapped : json);
    if (!parsed.success) {
      throw badResponse('systemone', `unexpected response shape (${parsed.error.issues[0]?.message ?? 'invalid'})`, text, secrets);
    }

    const answers: Record<string, DecideAnswer> = {};
    for (const [id, question] of Object.entries(req.questions)) {
      const raw = parsed.data[id];
      if (!raw) throw badResponse('systemone', `no answer for question "${id}"`, text, secrets);
      try {
        answers[id] = normalizeAnswer(question, raw);
      } catch (error) {
        throw badResponse('systemone', `invalid answer for "${id}": ${error instanceof Error ? error.message : 'invalid'}`, text, secrets);
      }
    }
    return answers;
  }

  return {
    capabilities,
    decide: (req) => fanOut(req, capabilities, callOnce),
  };
}
