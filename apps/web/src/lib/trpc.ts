import type { AppRouter } from '@s1pilot/server/router';
import { QueryClient } from '@tanstack/react-query';
import { createTRPCUntypedClient, httpBatchLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';
import type { inferRouterOutputs } from '@trpc/server';


/** Output types of every procedure, e.g. `RouterOutputs['models']['probe']`. */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

/** Typed React hooks for every procedure that exists in `AppRouter`. */
export const trpc = createTRPCReact<AppRouter>();

/** Resolves `globalThis.fetch` per call so tests can stub it after import. */
const lateFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

function links(fetchImpl: typeof fetch = lateFetch) {
  // Split batches before the URL gets long enough for a proxy or server to reject it.
  return [httpBatchLink({ url: '/trpc', fetch: fetchImpl, maxURLLength: 4000 })];
}

/** Creates the React-bound tRPC client used by `trpc.Provider`. Tests pass a fake `fetch`. */
export function createTrpcClient(fetchImpl?: typeof fetch) {
  return trpc.createClient({ links: links(fetchImpl) });
}

/**
 * Untyped client for procedures that may not exist yet (wizard: `cases.create` TODO(S-033), `runs.start` TODO(S-034)). Replace with typed hooks once those routers are in `AppRouter`.
 */
export const untypedClient = createTRPCUntypedClient<AppRouter>({ links: links() });

/** Query client: no retries by default (a missing server should show an error state, not hammer), short stale time. */
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 10_000, refetchOnWindowFocus: false } } });
}
