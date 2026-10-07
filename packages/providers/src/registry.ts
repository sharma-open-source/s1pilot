import {
  S1PilotError,
  type AdapterKind,
  type DecisionModel,
  type ModelEndpoint,
  type Profile,
  type Redactor,
} from '@s1pilot/domain';

import { createDecideModel } from './adapters/decide.js';
import { MOCK_CAPABILITIES, MockChatModel, MockDecisionModel } from './adapters/mock.js';
import { createOpenAiChatModel } from './adapters/openai-chat.js';
import { createOpenAiLogprobsModel } from './adapters/openai-logprobs.js';
import { createSystemOneModel } from './adapters/systemone.js';
import type { ChatModel } from './contract.js';
import { loadProfile } from './profiles.js';
import { guardDecisionModel } from './util/guard.js';

export interface CreateModelOptions {
  /** Resolved API key (from `endpoint.apiKeyRef`); adapters must never log it. */
  apiKey?: string;
  /** Per-call timeout, default 30 000 ms. */
  timeoutMs?: number;
  /** Retries on 5xx/network failures, default 1. */
  retries?: number;
  retryDelayMs?: number;
  /** HTTP implementation for real adapters (tests inject a mock). */
  fetch?: typeof fetch;
  /** `openai-logprobs`: characters used as single-token option labels. Default `A-Z` then `0-9`. */
  labelAlphabet?: string;
  /** `openai-chat`: scrubs every prompt (secrets, patterns, built-ins) before it is sent. */
  redactor?: Redactor;
  /** Receives non-fatal adapter warnings (e.g. label tokens missing from the logprobs). */
  onWarning?: (warning: ModelWarning) => void;
  /** Use this instance for `adapter: 'mock'` so tests can inspect its recorded calls. */
  mock?: MockDecisionModel;
  mockChat?: MockChatModel;
}

/** A non-fatal problem an adapter noticed (never contains secrets). */
export interface ModelWarning {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface AdapterContext {
  endpoint: ModelEndpoint;
  /** Loaded when `endpoint.profileId` is set. */
  profile?: Profile;
  options: CreateModelOptions;
}

export type DecisionAdapterFactory = (ctx: AdapterContext) => DecisionModel;
export type ChatAdapterFactory = (ctx: AdapterContext) => ChatModel;

const decisionAdapters = new Map<AdapterKind, DecisionAdapterFactory>();
const chatAdapters = new Map<AdapterKind, ChatAdapterFactory>();

/** Registers (or replaces) a System 1 adapter. Real adapters register themselves in S-007–S-009. */
export function registerDecisionAdapter(name: AdapterKind, factory: DecisionAdapterFactory): void {
  decisionAdapters.set(name, factory);
}

/** Registers (or replaces) a System 2 adapter. The real one registers itself in S-010. */
export function registerChatAdapter(name: AdapterKind, factory: ChatAdapterFactory): void {
  chatAdapters.set(name, factory);
}

registerDecisionAdapter('systemone', createSystemOneModel);
registerDecisionAdapter('decide', createDecideModel);
registerDecisionAdapter('openai-logprobs', createOpenAiLogprobsModel);
registerDecisionAdapter('mock', ({ profile, options }) =>
  options.mock ?? new MockDecisionModel({ capabilities: profile?.capabilities ?? MOCK_CAPABILITIES }),
);
registerChatAdapter('openai-chat', createOpenAiChatModel);
registerChatAdapter('mock', ({ options }) => options.mockChat ?? new MockChatModel());

/**
 * Creates a System 1 model for `endpoint`, wrapped with a timeout and one retry on 5xx/network errors.
 * Throws `ADAPTER_NOT_FOUND` when the adapter is not registered, `INVALID_ADAPTER_ROLE` for `openai-chat`.
 */
export function createDecisionModel(endpoint: ModelEndpoint, options: CreateModelOptions = {}): DecisionModel {
  if (endpoint.adapter === 'openai-chat') {
    throw new S1PilotError('INVALID_ADAPTER_ROLE', 'The "openai-chat" adapter is a System 2 model; use createChatModel', {
      adapter: endpoint.adapter,
    });
  }
  const factory = decisionAdapters.get(endpoint.adapter);
  if (!factory) {
    throw new S1PilotError('ADAPTER_NOT_FOUND', `System 1 adapter "${endpoint.adapter}" is not registered`, {
      adapter: endpoint.adapter,
    });
  }
  const profile = endpoint.profileId !== undefined ? loadProfile(endpoint.profileId) : undefined;
  const model = factory({ endpoint, ...(profile ? { profile } : {}), options });
  return guardDecisionModel(model, {
    timeoutMs: options.timeoutMs ?? 30_000,
    ...(options.retries !== undefined ? { retries: options.retries } : {}),
    ...(options.retryDelayMs !== undefined ? { retryDelayMs: options.retryDelayMs } : {}),
  });
}

/** Creates a System 2 chat model. Only `openai-chat` and `mock` endpoints are valid. */
export function createChatModel(endpoint: ModelEndpoint, options: CreateModelOptions = {}): ChatModel {
  if (endpoint.adapter !== 'openai-chat' && endpoint.adapter !== 'mock') {
    throw new S1PilotError('INVALID_ADAPTER_ROLE', `Adapter "${endpoint.adapter}" is a System 1 model; use createDecisionModel`, {
      adapter: endpoint.adapter,
    });
  }
  const factory = chatAdapters.get(endpoint.adapter);
  if (!factory) {
    throw new S1PilotError('ADAPTER_NOT_FOUND', `System 2 adapter "${endpoint.adapter}" is not registered`, {
      adapter: endpoint.adapter,
    });
  }
  return factory({ endpoint, options });
}
