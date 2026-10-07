import { S1PilotError } from '@s1pilot/domain';
import type { ZodType, ZodTypeDef } from 'zod';

/** Current time as an ISO-8601 UTC string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** SQL NULL → absent field, so rows validate against optional domain fields. */
export function nullsToUndefined<T extends object>(row: T): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value === null ? undefined : value]),
  ) as T;
}

/** Validates a DB row against its domain schema. */
export function fromRow<O, I>(schema: ZodType<O, ZodTypeDef, I>, row: object): O {
  return schema.parse(nullsToUndefined(row));
}

/** Throws `NOT_FOUND` for a missing entity. */
export function notFound(entity: string, id: string): never {
  throw new S1PilotError('NOT_FOUND', `${entity} not found: ${id}`, { entity, id });
}
