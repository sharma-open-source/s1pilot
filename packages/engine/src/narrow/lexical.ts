import type { ObservedElement } from '../observer/types.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'on', 'in', 'of', 'and', 'or', 'for', 'at', 'with', 'then', 'click', 'press', 'tap',
  'select', 'go', 'open', 'is', 'it', 'that', 'this', 'button', 'link', 'page', 'my', 'your', 'into', 'from',
]);

/** Lower-cased alphanumeric tokens of `text`, without stopwords. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t));
}

/**
 * Lexical relevance of an element to a step: fraction of distinct step tokens found (exactly, or as a
 * prefix of length >= 3 in either direction) in the element's name, text, placeholder and role. 0..1.
 */
export function lexicalScore(stepTokens: readonly string[], element: ObservedElement): number {
  const wanted = new Set(stepTokens);
  if (wanted.size === 0) return 0;
  const hay = tokenize([element.name, element.text ?? '', element.placeholder ?? '', element.role].join(' '));
  if (hay.length === 0) return 0;
  let hits = 0;
  for (const s of wanted) {
    if (hay.some((h) => h === s || (s.length >= 3 && h.length >= 3 && (h.startsWith(s) || s.startsWith(h))))) hits++;
  }
  return hits / wanted.size;
}

/** Elements sorted most relevant first; ties keep document order. Returns a new array plus the scores. */
export function orderByRelevance(
  elements: readonly ObservedElement[],
  stepText: string,
): { ordered: ObservedElement[]; scores: ReadonlyMap<string, number> } {
  const tokens = tokenize(stepText);
  const scores = new Map(elements.map((e) => [e.id, lexicalScore(tokens, e)]));
  const ordered = elements
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (scores.get(b.e.id) ?? 0) - (scores.get(a.e.id) ?? 0) || a.i - b.i)
    .map((x) => x.e);
  return { ordered, scores };
}
