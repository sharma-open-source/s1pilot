/** Splits a case query into whitespace-separated terms; double quotes group words (`owner:"Ann Lee"`). */
export function splitTerms(query: string): string[] {
  return query.match(/(?:[^\s"]+|"[^"]*"?)+/g) ?? [];
}

/** Field a term constrains (`priority`, `status`, `owner`, `tags`), or `undefined` for free text. */
export function termField(term: string): string | undefined {
  const m = /^(priority|status|owner|tags?)(?:<=|>=|<|>|=|:)/i.exec(term);
  const f = m?.[1]?.toLowerCase();
  return f === 'tag' ? 'tags' : f;
}

/** Quotes a value when it contains whitespace. */
export function quoteValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

/** Replaces the `field` term(s) of `query` with `term` (or removes them when `term` is `undefined`). */
export function setFieldTerm(query: string, field: string, term: string | undefined): string {
  const rest = splitTerms(query)
    .filter((t) => termField(t) !== field)
    .join(' ');
  return [rest, term].filter((x): x is string => x !== undefined && x !== '').join(' ');
}

/** The value currently set for `field` (`priority=P1` gives `P1`), if any. */
export function fieldValue(query: string, field: string): string | undefined {
  const term = splitTerms(query).find((t) => termField(t) === field);
  if (term === undefined) return undefined;
  return term.replace(/^[a-z]+(?:<=|>=|<|>|=|:)/i, '').replace(/^"|"$/g, '');
}
