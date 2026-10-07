import {
  S1PilotError,
  type Capabilities,
  type DecideAnswer,
  type DecideRequest,
  type DecisionModel,
  type Question,
} from '@s1pilot/domain';
import type { ZodType, ZodTypeDef } from 'zod';

import type { ChatModel, ChatRequest, PickOptionRequest } from '../contract.js';
import { chatJsonWith } from '../util/chat-json.js';
import { fanOut } from '../util/fanout.js';
import { normalizeAnswer, type RawAnswer } from '../util/normalize.js';

/** What a script entry answers. Unset probabilities are synthesised from `confidence` (default 0.9). */
export interface MockAnswer extends RawAnswer {
  confidence?: number;
}

export type MockResolver = (question: Question, state: unknown, id: string) => MockAnswer;

export interface MockRule {
  match: (question: Question, state: unknown, id: string) => boolean;
  answer: MockAnswer | MockResolver;
}

export interface MockOptions {
  /** Rules are tried in order; the first match answers. */
  script?: MockRule[];
  /** Used when no rule matches. Default: `fallbacks.first()`. */
  fallback?: MockResolver;
  capabilities?: Partial<Capabilities>;
}

export interface MockCall {
  request: DecideRequest;
  response: Record<string, DecideAnswer>;
}

export const MOCK_CAPABILITIES: Capabilities = {
  maxOptions: 256,
  multiQuestionPerCall: true,
  supportsImages: false,
  maxContextTokens: 32768,
  orderSensitive: false,
};

/** Fallback strategies for questions no script rule matches. */
export const fallbacks = {
  /** First option for `choice`, level 0 for `score`, P(true) 0.9 for `noul`. */
  first: (): MockResolver => (question) => {
    if (question.type === 'choice') return { choice: Object.keys(question.criteria)[0] as string };
    if (question.type === 'score') return { score: 0 };
    return { noul: 0.9 };
  },

  /** Deterministic pseudo-random answers (mulberry32) for a given seed. */
  random: (seed: number): MockResolver => {
    let state = seed >>> 0;
    const next = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return (question) => {
      if (question.type === 'choice') {
        const keys = Object.keys(question.criteria);
        return { choice: keys[Math.floor(next() * keys.length)] as string };
      }
      if (question.type === 'score') return { score: Math.floor(next() * question.criteria.length) };
      return { noul: next() };
    };
  },

  /**
   * `choice`: the first option whose description includes `text` (case-insensitive), else the first.
   * `noul`: true (0.9) when the observation contains `text`, else false (0.1). `score`: top level if matched, else 0.
   */
  byLabelIncludes:
    (text: string): MockResolver =>
    (question, state) => {
      const needle = text.toLowerCase();
      if (question.type === 'choice') {
        const hit = Object.entries(question.criteria).find(([, label]) => label.toLowerCase().includes(needle));
        return { choice: hit ? hit[0] : (Object.keys(question.criteria)[0] as string) };
      }
      const seen = JSON.stringify(state ?? '').toLowerCase().includes(needle);
      if (question.type === 'score') return { score: seen ? question.criteria.length - 1 : 0 };
      return { noul: seen ? 0.9 : 0.1 };
    },
};

/** Spreads `confidence` onto the chosen label and the remainder over the others. */
function distribution(labels: string[], chosen: number, confidence: number): Record<string, number> {
  const rest = labels.length > 1 ? (1 - confidence) / (labels.length - 1) : 0;
  return Object.fromEntries(labels.map((label, i) => [label, labels.length === 1 ? 1 : i === chosen ? confidence : rest]));
}

function toAnswer(question: Question, answer: MockAnswer): DecideAnswer {
  const confidence = answer.confidence ?? 0.9;
  if (answer.probabilities !== undefined || question.type === 'noul') {
    return normalizeAnswer(question, { ...answer, noul: answer.noul ?? (question.type === 'noul' ? confidence : undefined) });
  }
  if (question.type === 'choice') {
    const labels = Object.keys(question.criteria);
    const chosen = labels.indexOf(answer.choice ?? '');
    if (chosen < 0) throw new S1PilotError('MODEL_BAD_RESPONSE', `Mock answered unknown option "${answer.choice}"`);
    return normalizeAnswer(question, { choice: answer.choice, probabilities: distribution(labels, chosen, confidence) });
  }
  const levels = question.criteria;
  const index = Math.min(levels.length - 1, Math.max(0, Math.round(answer.score ?? 0)));
  return normalizeAnswer(question, { score: index, probabilities: distribution(levels, index, confidence) });
}

/** Deterministic, scriptable `DecisionModel` for tests and demos. Records every call. */
export class MockDecisionModel implements DecisionModel {
  readonly capabilities: Capabilities;
  /** Every `decide` request and its response, oldest first. */
  readonly calls: MockCall[] = [];
  private readonly script: MockRule[];
  private readonly fallback: MockResolver;

  constructor(options: MockOptions = {}) {
    this.capabilities = { ...MOCK_CAPABILITIES, ...options.capabilities };
    this.script = options.script ?? [];
    this.fallback = options.fallback ?? fallbacks.first();
  }

  async decide(req: DecideRequest): Promise<Record<string, DecideAnswer>> {
    const response = await fanOut(req, this.capabilities, async (part) => {
      const out: Record<string, DecideAnswer> = {};
      for (const [id, question] of Object.entries(part.questions)) {
        const rule = this.script.find((r) => r.match(question, part.state, id));
        const raw = rule ? (typeof rule.answer === 'function' ? rule.answer(question, part.state, id) : rule.answer) : this.fallback(question, part.state, id);
        out[id] = toAnswer(question, raw);
      }
      return out;
    });
    this.calls.push({ request: req, response });
    return response;
  }
}

export interface MockChatOptions {
  /** Replies returned by successive `chat` calls. */
  replies?: (string | ((req: ChatRequest) => string))[];
  /** Reply once `replies` is exhausted. Default `"ok"`. */
  fallbackReply?: string;
  /** Chooses an option id for `pickOption`. Default: the first option. */
  pick?: (req: PickOptionRequest) => string;
}

/** Scriptable System 2 stand-in for tests. */
export class MockChatModel implements ChatModel {
  readonly chatCalls: ChatRequest[] = [];
  readonly pickCalls: PickOptionRequest[] = [];
  private readonly replies: NonNullable<MockChatOptions['replies']>;

  constructor(private readonly options: MockChatOptions = {}) {
    this.replies = [...(options.replies ?? [])];
  }

  async chat(req: ChatRequest): Promise<{ text: string; latencyMs: number }> {
    this.chatCalls.push(req);
    const reply = this.replies.shift() ?? this.options.fallbackReply ?? 'ok';
    return { text: typeof reply === 'function' ? reply(req) : reply, latencyMs: 0 };
  }

  chatJson<T>(req: Omit<ChatRequest, 'json'>, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T> {
    return chatJsonWith((r) => this.chat(r), req, schema);
  }

  async pickOption(req: PickOptionRequest): Promise<{ choice: string; rationale?: string }> {
    this.pickCalls.push(req);
    const choice = this.options.pick?.(req) ?? (Object.keys(req.options)[0] as string);
    if (!(choice in req.options)) {
      throw new S1PilotError('MODEL_BAD_RESPONSE', `Mock chose unknown option "${choice}"`, { choice });
    }
    return { choice, rationale: 'mock' };
  }
}
