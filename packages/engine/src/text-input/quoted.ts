const QUOTED = /"([^"\n]+)"|“([^”\n]+)”/g;

/** Value ref for the (first) value quoted in the step's own text, resolved from the unredacted step text. */
export const QUOTE_REF = 'quote:1';
/** Value ref for all quoted values of the step, newline-separated (several options of a multi-select). */
export const QUOTE_ALL_REF = 'quote:all';

/** Distinct values quoted in a step's text, in order of appearance. */
export function quotedValues(text: string): string[] {
  const values = new Set<string>();
  for (const m of text.matchAll(QUOTED)) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (v) values.add(v);
  }
  return [...values];
}

/**
 * The value quoted in a step's text (`Type "JavaScript" in the search box` → `JavaScript`), or
 * `undefined` when the text quotes nothing or several different values (ambiguous).
 */
export function quotedValue(text: string): string | undefined {
  const values = quotedValues(text);
  return values.length === 1 ? values[0] : undefined;
}

/** Resolves `quote:<n>` (1-based) or `quote:all` against the step text. */
export function resolveQuoteRef(key: string, stepText: string): string | undefined {
  const values = quotedValues(stepText);
  if (key === 'all') return values.length > 0 ? values.join('\n') : undefined;
  const n = Number(key);
  return Number.isInteger(n) && n >= 1 ? values[n - 1] : undefined;
}

/** Replaces `{name}` placeholders with parameter values; unknown placeholders stay as written. */
export function bindParams(text: string, params: Record<string, string>): string {
  return text.replace(/\{([\w.-]+)\}/g, (whole, name: string) => params[name] ?? whole);
}
