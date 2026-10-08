/** Human-readable message from a thrown value (tRPC errors carry the server message). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message;
  return 'Something went wrong';
}

/** The `data.code` of a tRPC client error (`CONFLICT`, `NOT_FOUND`, ...), if any. */
export function trpcCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'data' in err) {
    const data = (err as { data?: unknown }).data;
    if (typeof data === 'object' && data !== null && 'code' in data) {
      const code = (data as { code?: unknown }).code;
      return typeof code === 'string' ? code : undefined;
    }
  }
  return undefined;
}
