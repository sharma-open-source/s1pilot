import { z } from 'zod';

/** Opaque entity id (nanoid). */
export const IdSchema = z.string().min(1, 'id must not be empty');

/** ISO-8601 UTC timestamp, e.g. `2026-01-31T12:00:00.000Z`. */
export const IsoTimestampSchema = z.string().datetime({ message: 'Expected an ISO-8601 UTC timestamp' });

/** A probability or confidence in [0, 1]. */
export const ProbabilitySchema = z.number().min(0).max(1);

/** Map of option id → probability. */
export const ProbabilitiesSchema = z.record(ProbabilitySchema);
