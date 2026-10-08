import type { AppRouter } from '@s1pilot/server/router';
import { QueryClient } from '@tanstack/react-query';
import { createTRPCUntypedClient, httpBatchLink } from '@trpc/client';
import { createTRPCReact } from '@trpc/react-query';


/** Typed React hooks for every procedure that exists in `AppRouter`. */
export const trpc = createTRPCReact<AppRouter>();

function links() {
  return [httpBatchLink({ url: '/trpc' })];
}

/** Creates the React-bound tRPC client used by `trpc.Provider`. */
export function createTrpcClient() {
  return trpc.createClient({ links: links() });
}

/**
 * Untyped client for procedures that may not exist yet (nav data: `projects.list`, `models.status`).
 * TODO(S-032): replace with typed `trpc.projects.list` / `trpc.models.status` once those routers are in `AppRouter`.
 */
export const untypedClient = createTRPCUntypedClient<AppRouter>({ links: links() });

/** Query client: no retries by default (a missing server should show an error state, not hammer), short stale time. */
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 10_000, refetchOnWindowFocus: false } } });
}
