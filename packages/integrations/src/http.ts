import { S1PilotError } from '@s1pilot/domain';

import type { FetchLike } from './types.js';

/** Trims a base URL (no trailing slash). */
export const trimUrl = (u: string): string => u.replace(/\/+$/, '');

/**
 * Calls a tracker API and parses JSON. Non-2xx responses throw `TRACKER_HTTP` with the status and a short body excerpt.
 * Request headers (credentials) are never part of the error.
 */
export async function requestJson<T>(fetchImpl: FetchLike, url: string, init: RequestInit, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (error) {
    throw new S1PilotError('TRACKER_UNREACHABLE', `${what}: could not reach the tracker (${error instanceof Error ? error.message : 'network error'})`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new S1PilotError('TRACKER_HTTP', `${what}: tracker answered ${res.status}${text ? ` - ${text.slice(0, 200)}` : ''}`, { status: res.status });
  }
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new S1PilotError('TRACKER_BAD_RESPONSE', `${what}: tracker returned a non-JSON response`);
  }
}

/** Failed-connection result from a thrown error. */
export function failure(error: unknown): { ok: false; detail: string } {
  return { ok: false, detail: error instanceof Error ? error.message : 'Connection failed' };
}
