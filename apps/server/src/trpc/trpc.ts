import { S1PilotError } from '@s1pilot/domain/errors';
import { initTRPC, TRPCError } from '@trpc/server';

import type { Context } from './context.js';

type TrpcCode = ConstructorParameters<typeof TRPCError>[0]['code'];

/** Maps an S1PilotError code to a tRPC error code. */
export function trpcCodeFor(code: string): TrpcCode {
  if (code === 'NOT_FOUND' || code.endsWith('_NOT_FOUND')) return 'NOT_FOUND';
  if (code === 'FORBIDDEN' || code.endsWith('_FORBIDDEN')) return 'FORBIDDEN';
  if (code === 'UNAUTHORIZED') return 'UNAUTHORIZED';
  if (code === 'RATE_LIMITED') return 'TOO_MANY_REQUESTS';
  if (code === 'CONFLICT' || code.endsWith('_DUPLICATE')) return 'CONFLICT';
  if (code === 'INVALID_STATE') return 'PRECONDITION_FAILED';
  if (code.startsWith('MODEL_')) return 'BAD_GATEWAY';
  if (code === 'CONFIG_ERROR') return 'INTERNAL_SERVER_ERROR';
  if (/^(INVALID_|MISSING_)|(_INVALID|_ERROR)$/.test(code)) return 'BAD_REQUEST';
  return 'INTERNAL_SERVER_ERROR';
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    return {
      ...shape,
      data: {
        ...shape.data,
        ...(cause instanceof S1PilotError ? { s1Code: cause.code, details: cause.details ?? null } : {}),
      },
    };
  },
});

/** Rethrows an S1PilotError as a TRPCError with a matching code. */
const mapErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof S1PilotError) {
    const cause = result.error.cause;
    throw new TRPCError({ code: trpcCodeFor(cause.code), message: cause.message, cause });
  }
  return result;
});

export const router = t.router;
export const publicProcedure = t.procedure.use(mapErrors);
export const createCallerFactory = t.createCallerFactory;
