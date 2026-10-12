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

/** Weight of a step word found only in an element's context (hint, section, role, type), not its own text. */
const CONTEXT_WEIGHT = 0.5;

/**
 * Lexical relevance of an element to a step: per distinct step token, 1 when found (exactly, or as a
 * prefix of length >= 3 in either direction) in the element's own words (name, text, placeholder,
 * nearby label), else {@link CONTEXT_WEIGHT} when found only in its context (id hint, section heading,
 * role, input type; `color` also matches "colour"); averaged over the step tokens. 0..1. Own words
 * weigh more so a labelled "Volume: 50%" slider outranks an unnamed one hinted "video volume".
 */
export function lexicalScore(stepTokens: readonly string[], element: ObservedElement): number {
  const wanted = new Set(stepTokens);
  if (wanted.size === 0) return 0;
  const own = tokenize([element.name, element.text ?? '', element.placeholder ?? '', element.nearLabel ?? ''].join(' '));
  const type = element.inputType === 'color' ? 'color colour' : (element.inputType ?? '');
  const context = tokenize([element.idHint ?? '', element.section ?? '', element.role, type].join(' '));
  if (own.length === 0 && context.length === 0) return 0;
  const hit = (hay: readonly string[], s: string): boolean =>
    hay.some((h) => h === s || (s.length >= 3 && h.length >= 3 && (h.startsWith(s) || s.startsWith(h))));
  let score = 0;
  for (const s of wanted) {
    if (hit(own, s)) score += 1;
    else if (hit(context, s)) score += CONTEXT_WEIGHT;
  }
  return score / wanted.size;
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
  minScore = MIN_TEXT_SCORE,
): ObservedElement[] {
  const tokens = tokenize(stepText);
  if (tokens.length === 0) return [];
  return texts
    .map((e, i) => ({ e, i, s: lexicalScore(tokens, e) }))
    .filter((x) => x.s >= minScore)
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
