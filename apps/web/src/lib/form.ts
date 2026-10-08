import type { FieldValues, Resolver } from 'react-hook-form';
import type { ZodTypeAny, z } from 'zod';

/** Minimal zod resolver for react-hook-form (first issue per path wins). */
export function zodResolver<S extends ZodTypeAny>(schema: S): Resolver<z.infer<S> & FieldValues> {
  return (values) => {
    const parsed = schema.safeParse(values);
    if (parsed.success) return { values: parsed.data as z.infer<S> & FieldValues, errors: {} };
    const errors: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      if (path === '' || seen.has(path)) continue;
      seen.add(path);
      // Nested paths become the nested object react-hook-form expects.
      let target = errors;
      const parts = issue.path.map(String);
      for (const p of parts.slice(0, -1)) {
        target[p] = (target[p] as Record<string, unknown> | undefined) ?? {};
        target = target[p] as Record<string, unknown>;
      }
      target[parts[parts.length - 1] ?? ''] = { type: issue.code, message: issue.message };
    }
    return { values: {}, errors: errors as never };
  };
}
