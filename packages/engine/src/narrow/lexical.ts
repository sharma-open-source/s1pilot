import type { ObservedElement } from '../observer/types.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'on', 'in', 'of', 'and', 'or', 'for', 'at', 'with', 'then', 'click', 'press', 'tap',
  'select', 'go', 'open', 'is', 'it', 'that', 'this', 'button', 'link', 'page', 'my', 'your', 'into', 'from',
  'navigate', 'scroll', 'find', 'locate', 'text', 'view',
]);

/** Text blocks offered as action candidates per step, at most. */
export const MAX_TEXT_CANDIDATES = 5;
/** Minimum {@link lexicalScore} for a text block to be offered as a candidate. */
export const MIN_TEXT_SCORE = 0.5;

/** Lower-cased alphanumeric tokens of `text`, without stopwords. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t));
}

/**
 * Lexical relevance of an element to a step: fraction of distinct step tokens found (exactly, or as a
 * prefix of length >= 3 in either direction) in the element's name, text, placeholder, nearby label,
 * role and input type (`color` also matches "colour"). 0..1.
 */
export function lexicalScore(stepTokens: readonly string[], element: ObservedElement): number {
  const wanted = new Set(stepTokens);
  if (wanted.size === 0) return 0;
  const type = element.inputType === 'color' ? 'color colour' : (element.inputType ?? '');
  const hay = tokenize([element.name, element.text ?? '', element.placeholder ?? '', element.nearLabel ?? '', element.role, type].join(' '));
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

/**
 * Text blocks worth offering as action candidates for a step: those whose lexical score is at least
 * {@link MIN_TEXT_SCORE}, best first (ties: headings, then shorter text, then document order), at most
 * `limit`. Lets a step such as "scroll to Customer reviews" or "click Free shipping" target page
 * text that is not an interactive control.
 */
export function matchingTexts(
  texts: readonly ObservedElement[],
  stepText: string,
  limit = MAX_TEXT_CANDIDATES,
): ObservedElement[] {
  const tokens = tokenize(stepText);
  if (tokens.length === 0) return [];
  return texts
    .map((e, i) => ({ e, i, s: lexicalScore(tokens, e) }))
    .filter((x) => x.s >= MIN_TEXT_SCORE)
    .sort(
      (a, b) =>
        b.s - a.s ||
        Number(b.e.role === 'heading') - Number(a.e.role === 'heading') ||
        (a.e.text ?? a.e.name).length - (b.e.text ?? b.e.name).length ||
        a.i - b.i,
    )
    .slice(0, limit)
    .map((x) => x.e);
}
