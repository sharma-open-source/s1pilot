import { nanoid } from 'nanoid';

import { S1PilotError } from './errors.js';

/** Allowed shape of a project key such as `SHOP`. */
export const PROJECT_KEY_REGEX = /^[A-Z][A-Z0-9]{1,9}$/;

const CASE_KEY_REGEX = /^([A-Z][A-Z0-9]{1,9})-TC-([1-9]\d*)$/;

/** Generates a new 21-character entity id. */
export function newId(): string {
  return nanoid();
}

/** Builds a human case key, e.g. `caseKey('SHOP', 42)` → `SHOP-TC-42`. */
export function caseKey(projectKey: string, n: number): string {
  if (!PROJECT_KEY_REGEX.test(projectKey)) {
    throw new S1PilotError('INVALID_PROJECT_KEY', `Invalid project key: ${projectKey}`);
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new S1PilotError('INVALID_CASE_NUMBER', `Case number must be a positive integer: ${n}`);
  }
  return `${projectKey}-TC-${n}`;
}

/** Parses `SHOP-TC-42` into its parts; throws `S1PilotError` (`INVALID_CASE_KEY`) otherwise. */
export function parseCaseKey(key: string): { projectKey: string; number: number } {
  const match = CASE_KEY_REGEX.exec(key);
  const projectKey = match?.[1];
  const num = match?.[2];
  if (projectKey === undefined || num === undefined) {
    throw new S1PilotError('INVALID_CASE_KEY', `Invalid case key: ${key}`, { key });
  }
  return { projectKey, number: Number(num) };
}
