import { createHash, randomBytes } from 'node:crypto';

import { FILE_REF_PREFIX, sampleFile } from './files.js';
import { resolveQuoteRef } from './quoted.js';

/** Run-scoped store for literal values produced by System 2 or a human. Never persisted. */
export interface LiteralStore {
  /** Stores `value` and returns its `literal:<hash>` reference (same value, same ref). */
  put(value: string): string;
  /** Returns the literal behind a `literal:<hash>` ref, or `undefined`. */
  get(ref: string): string | undefined;
}

/** Creates an empty {@link LiteralStore}. Hashes are salted per store so refs reveal nothing. */
export function createLiteralStore(): LiteralStore {
  const salt = randomBytes(8);
  const byRef = new Map<string, string>();
  return {
    put(value) {
      const hash = createHash('sha256').update(salt).update(value).digest('hex').slice(0, 12);
      const ref = `literal:${hash}`;
      byRef.set(ref, value);
      return ref;
    },
    get: (ref) => byRef.get(ref),
  };
}

/** Variable lookup needed to resolve `var:` / `secret:` refs (structurally a `ResolvedVars`). */
export interface VarLookup {
  get(key: string): string | undefined;
}

/**
 * Builds the executor's `resolveValue` for `var:`, `secret:`, `param:`, `literal:`, `quote:` and
 * `text:` refs (`quote:<n>` is the n-th value quoted in `stepText`, `quote:all` all of them
 * newline-separated; `text:<value>` carries the value inline), and
 * `file:<name>` refs, which resolve to the path of a generated sample file for uploads.
 * Throws for unknown refs, naming the ref (never a value).
 */
export function createValueResolver(opts: {
  vars: VarLookup;
  params?: Record<string, string>;
  literals?: LiteralStore;
  /** Unredacted, parameter-bound text of the current step, for `quote:` refs. */
  stepText?: string;
}): (ref: string) => string {
  return (ref) => {
    const idx = ref.indexOf(':');
    const kind = idx < 0 ? '' : ref.slice(0, idx);
    const key = ref.slice(idx + 1);
    let value: string | undefined;
    if (kind === 'var' || kind === 'secret') value = opts.vars.get(key);
    else if (kind === 'param') value = opts.params?.[key];
    else if (kind === 'literal') value = opts.literals?.get(ref);
    else if (kind === 'text' && key.length > 0) value = key;
    else if (kind === 'empty') value = '';
    else if (kind === 'quote' && opts.stepText !== undefined) value = resolveQuoteRef(key, opts.stepText);
    else if (`${kind}:` === FILE_REF_PREFIX && key.length > 0) value = sampleFile(key);
    if (value === undefined) throw new Error(`Unknown value reference ${ref}`);
    return value;
  };
}
