import { createRedactor, S1PilotError } from '@s1pilot/domain';

const SNIPPET_LENGTH = 500;

/** `{baseUrl}{path}` without doubled slashes. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** First 500 characters of `text` with secrets and sensitive-looking values redacted. */
export function safeSnippet(text: string, secrets: string[] = []): string {
  const redacted = createRedactor({ secrets, patterns: [] }).redact(text);
  return redacted.length > SNIPPET_LENGTH ? `${redacted.slice(0, SNIPPET_LENGTH)}…` : redacted;
}

/** Builds a `MODEL_BAD_RESPONSE` error carrying a redacted, truncated snippet of the raw body. */
export function badResponse(adapter: string, reason: string, body: string, secrets: string[] = []): S1PilotError {
  return new S1PilotError('MODEL_BAD_RESPONSE', `${adapter}: ${reason}`, {
    adapter,
    snippet: safeSnippet(body, secrets),
  });
}

export interface PostJsonOptions {
  adapter: string;
  url: string;
  body: unknown;
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs: number;
}

/**
 * POSTs JSON and returns the response text.
 * Errors: `MODEL_TIMEOUT`, `MODEL_NETWORK` (retryable), `MODEL_HTTP` with `details.status` and a redacted snippet.
 */
export async function postJson(opts: PostJsonOptions): Promise<string> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const secrets = opts.apiKey ? [opts.apiKey] : [];
  let response: Response;
  try {
    response = await doFetch(opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new S1PilotError('MODEL_TIMEOUT', `${opts.adapter}: request timed out after ${opts.timeoutMs} ms`, {
        timeoutMs: opts.timeoutMs,
      });
    }
    throw new S1PilotError('MODEL_NETWORK', `${opts.adapter}: could not reach the model server`, { adapter: opts.adapter });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new S1PilotError('MODEL_HTTP', `${opts.adapter}: server returned HTTP ${response.status}`, {
      adapter: opts.adapter,
      status: response.status,
      snippet: safeSnippet(text, secrets),
    });
  }
  return text;
}
