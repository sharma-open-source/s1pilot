import { S1PilotError } from '@s1pilot/domain';
import type { ZodType, ZodTypeDef } from 'zod';

import type { ChatRequest } from '../contract.js';

import { safeSnippet } from './http.js';

type ChatFn = (req: ChatRequest) => Promise<{ text: string; latencyMs: number }>;

/** Strips a Markdown code fence some models wrap around JSON. */
function unfence(text: string): string {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return (match?.[1] ?? text).trim();
}

/** Parses and validates one reply; returns the value or the reason it was rejected. */
function validate<T>(text: string, schema: ZodType<T, ZodTypeDef, unknown>): { ok: true; value: T } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(unfence(text));
  } catch {
    return { ok: false, reason: 'the reply is not valid JSON' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const reason = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ');
  return { ok: false, reason };
}

/**
 * Asks `chat` for JSON and validates it with `schema`. If the first reply is rejected, the model is
 * shown the reason and asked once more; a second rejection throws `MODEL_BAD_RESPONSE`.
 * That is at most two model calls.
 */
export async function chatJsonWith<T>(
  chat: ChatFn,
  req: Omit<ChatRequest, 'json'>,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> {
  const first = await chat({ ...req, json: true });
  const firstResult = validate(first.text, schema);
  if (firstResult.ok) return firstResult.value;

  const repair = await chat({
    ...req,
    json: true,
    messages: [
      ...req.messages,
      { role: 'assistant', content: first.text },
      { role: 'user', content: `Your previous reply was rejected: ${firstResult.reason}. Reply again with only a valid JSON object.` },
    ],
  });
  const repaired = validate(repair.text, schema);
  if (repaired.ok) return repaired.value;
  throw new S1PilotError('MODEL_BAD_RESPONSE', 'Chat model did not return valid JSON after one repair attempt', {
    reason: repaired.reason,
    snippet: safeSnippet(repair.text),
  });
}
