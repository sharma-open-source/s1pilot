import { can } from '@s1pilot/domain';
import { S1PilotError } from '@s1pilot/domain/errors';
import { initTRPC, TRPCError } from '@trpc/server';

import { recordAudit } from '../audit/audit.js';
import { AUDIT_RULES } from '../audit/rules.js';

import { PUBLIC_PROCEDURES, permissionFor } from './authz.js';
import type { Context } from './context.js';

type TrpcCode = ConstructorParameters<typeof TRPCError>[0]['code'];

/** Maps an S1PilotError code to a tRPC error code. */
export function trpcCodeFor(code: string): TrpcCode {
  if (code === 'NOT_FOUND' || code.endsWith('_NOT_FOUND')) return 'NOT_FOUND';
  if (code === 'FORBIDDEN' || code.endsWith('_FORBIDDEN')) return 'FORBIDDEN';
  if (code === 'UNAUTHORIZED') return 'UNAUTHORIZED';
  if (code === 'RATE_LIMITED') return 'TOO_MANY_REQUESTS';
  if (code === 'CONFLICT' || code.endsWith('_DUPLICATE')) return 'CONFLICT';
  if (code.startsWith('AUTH_')) return 'PRECONDITION_FAILED';
  if (code === 'INVALID_STATE') return 'PRECONDITION_FAILED';
  if (code.startsWith('MODEL_')) return 'BAD_GATEWAY';
  if (['TRACKER_CONFIG', 'TRACKER_NOT_MAPPED', 'TRACKER_NOT_CONNECTED'].includes(code)) return 'PRECONDITION_FAILED';
  if (code.startsWith('TRACKER_')) return 'BAD_GATEWAY';
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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Authentication, role permissions and audit logging for every procedure (S-067).
 * - team mode without a session: `UNAUTHORIZED` (except the public `session.*` procedures);
 * - role lacks the permission of the procedure ({@link permissionFor}): `FORBIDDEN`;
 * - successful audited mutations ({@link AUDIT_RULES}) append an audit entry with the before/after diff.
 */
const authz = t.middleware(async ({ ctx, path, type, getRawInput, next }) => {
  if (PUBLIC_PROCEDURES.has(path)) return next();
  if (ctx.anonymous) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in required' });
  const permission = permissionFor(path, type);
  if (!can(ctx.user.role, permission)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `Your role (${ctx.user.role}) cannot do this (needs ${permission})` });
  }
  const rule = type === 'mutation' ? AUDIT_RULES[path] : undefined;
  if (!rule) return next();
  const raw = await getRawInput();
  const input = isObject(raw) ? raw : { id: raw };
  const before = rule.before ? await rule.before(ctx, input).catch(() => undefined) : undefined;
  const result = await next();
  if (result.ok) {
    const out = isObject(result.data) ? result.data : {};
    const described = rule.describe({ input, result: out, before });
    const { after, ...rest } = described;
    await recordAudit(ctx, {
      ...rest,
      ...(before !== undefined || rule.before ? { before: before ?? null } : {}),
      after: after !== undefined ? after : rule.afterFromInput ? input : result.data,
    });
  }
  return result;
});

export const router = t.router;
export const publicProcedure = t.procedure.use(mapErrors).use(authz);
export const createCallerFactory = t.createCallerFactory;
