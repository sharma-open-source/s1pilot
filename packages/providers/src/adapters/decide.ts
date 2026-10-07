import {
  type Capabilities,
  type DecideAnswer,
  type DecideRequest,
  type DecisionModel,
  type Question,
} from '@s1pilot/domain';

import type { AdapterContext } from '../registry.js';
import { fanOut } from '../util/fanout.js';
import { retryQuestion } from '../util/guard.js';
import { badResponse, joinUrl, postJson } from '../util/http.js';
import { normalizeAnswer } from '../util/normalize.js';
import { AnswerWireSchema } from '../util/wire.js';

/** Used when the endpoint has no `profileId`. `maxOptions` is the JEV limit; there is no lower cap here. */
export const DECIDE_DEFAULT_CAPABILITIES: Capabilities = {
  maxOptions: 256,
  multiQuestionPerCall: false,
  supportsImages: false,
  maxContextTokens: 16384,
  orderSensitive: true,
};

/** Translates a domain `Question` into the JEV `question` object (options list / boolean / scale). */
export function toDecideQuestion(question: Question): Record<string, unknown> {
  switch (question.type) {
    case 'choice':
      return {
        kind: 'choice',
        instructions: question.instructions,
        options: Object.entries(question.criteria).map(([id, text]) => ({ id, text })),
      };
    case 'noul':
      return { kind: 'boolean', instructions: question.instructions };
    case 'score':
      return { kind: 'scale', instructions: question.instructions, levels: question.criteria };
  }
}

/**
 * Creates the model for `POST {baseUrl}/v1/decide` (JEV family): one question per call,
 * fanned out at most 4 in parallel. Wire format: see `decide.md`.
 */
export function createDecideModel(ctx: AdapterContext): DecisionModel {
  const { endpoint, options } = ctx;
  // The endpoint takes exactly one question per call, whatever a profile says.
  const capabilities: Capabilities = { ...(ctx.profile?.capabilities ?? DECIDE_DEFAULT_CAPABILITIES), multiQuestionPerCall: false };
  const url = joinUrl(endpoint.baseUrl ?? '', '/v1/decide');
  const secrets = options.apiKey ? [options.apiKey] : [];

  async function ask(question: Question, req: DecideRequest): Promise<DecideAnswer> {
    const body = {
      model: endpoint.model,
      state: req.state,
      ...(capabilities.supportsImages && req.images && req.images.length > 0
        ? { images: req.images.map((image) => ({ media_type: image.mediaType, data: image.data })) }
        : {}),
      question: toDecideQuestion(question),
    };
    const text = await postJson({
      adapter: 'decide',
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
      throw badResponse('decide', 'response is not valid JSON', text, secrets);
    }
    const parsed = AnswerWireSchema.safeParse(json);
    if (!parsed.success) {
      throw badResponse('decide', `unexpected response shape (${parsed.error.issues[0]?.message ?? 'invalid'})`, text, secrets);
    }
    try {
      return normalizeAnswer(question, parsed.data);
    } catch (error) {
      throw badResponse('decide', `invalid answer: ${error instanceof Error ? error.message : 'invalid'}`, text, secrets);
    }
  }

  return {
    capabilities,
    decide: (req) =>
      fanOut(req, capabilities, async (part) => {
        const [id, question] = Object.entries(part.questions)[0] ?? [];
        if (id === undefined || question === undefined) return {};
        return { [id]: await retryQuestion(id, options, () => ask(question, part)) };
      }),
  };
}
