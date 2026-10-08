import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { createQueryClient, createTrpcClient, trpc } from '@/lib/trpc';

export type Handler = (input: unknown) => unknown;

export interface FakeTrpc {
  fetch: typeof fetch;
  /** Every call in order: `{ path, input }`. */
  calls: Array<{ path: string; input: unknown }>;
}

/** Error a handler can throw to produce a tRPC error response with `data.code`. */
export class FakeTrpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/**
 * Fake `fetch` for the tRPC `httpBatchLink`: answers `/trpc/a.b,c.d?batch=1` from `handlers` keyed by procedure path.
 * Unknown procedures answer NOT_FOUND.
 */
export function createFakeTrpc(handlers: Record<string, Handler>): FakeTrpc {
  const calls: FakeTrpc['calls'] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost');
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, '')).split(',');
    const raw = init?.method === 'POST' ? String(init.body ?? '{}') : (url.searchParams.get('input') ?? '{}');
    const inputs = JSON.parse(raw) as Record<string, unknown>;
    const results = await Promise.all(
      paths.map(async (path, i) => {
        const arg = inputs[String(i)];
        calls.push({ path, input: arg });
        const handler = handlers[path];
        try {
          if (!handler) throw new FakeTrpcError(`No procedure ${path}`, 'NOT_FOUND');
          return { result: { data: await handler(arg) } };
        } catch (err) {
          const code = err instanceof FakeTrpcError ? err.code : 'INTERNAL_SERVER_ERROR';
          return {
            error: {
              message: err instanceof Error ? err.message : 'error',
              code: -32603,
              data: { code, httpStatus: 500, path },
            },
          };
        }
      }),
    );
    return new Response(JSON.stringify(results), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

/** Provides tRPC + react-query backed by a fake `fetch`. */
export function FakeTrpcProvider({ fake, children }: { fake: FakeTrpc; children: ReactNode }) {
  const [client] = useState(() => createTrpcClient(fake.fetch));
  const [queryClient] = useState(createQueryClient);
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
