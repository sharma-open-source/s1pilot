import { S1PilotError, type DecisionModel } from '@s1pilot/domain';

export interface GuardOptions {
  /** Per-call timeout in ms. */
  timeoutMs: number;
  /** Extra attempts after a retryable failure (5xx / network). Default 1. */
  retries?: number;
  /** Wait before a retry, in ms. Default 200. */
  retryDelayMs?: number;
}

/**
 * Runs `fn`, rejecting with `S1PilotError('MODEL_TIMEOUT')` after `ms`.
 * `fn` receives an `AbortSignal` that fires on timeout so adapters can cancel the request.
 */
export async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new S1PilotError('MODEL_TIMEOUT', `Model call timed out after ${ms} ms`, { timeoutMs: ms }));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True for failures worth one more try: network errors and HTTP 5xx (never timeouts or 4xx).
 * Errors marked `details.retried` already used an adapter-level retry and are final.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof S1PilotError) {
    if (error.details?.['retried'] === true) return false;
    if (error.code === 'MODEL_NETWORK') return true;
    const status = error.details?.['status'];
    return error.code === 'MODEL_HTTP' && typeof status === 'number' && status >= 500;
  }
  return error instanceof TypeError; // fetch() network failure
}

/** Retries `fn` up to `retries` times while `isRetryable(error)`. */
export async function withRetry<T>(fn: () => Promise<T>, retries = 1, delayMs = 200): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Wraps a model so every `decide` call has a timeout and one retry on 5xx/network failures. */
export function guardDecisionModel(model: DecisionModel, options: GuardOptions): DecisionModel {
  const { timeoutMs, retries = 1, retryDelayMs = 200 } = options;
  return {
    capabilities: model.capabilities,
    decide: (req) => withRetry(() => withTimeout(timeoutMs, () => model.decide(req)), retries, retryDelayMs),
  };
}
