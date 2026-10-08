/** Options for {@link wrapUntrusted}. */
export interface UntrustedOptions {
  /** Max characters kept (default 2000); longer text is cut and marked. */
  maxLength?: number;
  /** What the text is, e.g. `element-name`, `page-text`. */
  label?: string;
}

const DEFAULT_MAX = 2000;
const CLOSE = '<<<END_PAGE_DATA>>>';

/** Strips control characters (keeps \n and \t), neutralises delimiter look-alikes and caps length. */
export function sanitizeUntrusted(text: string, maxLength = DEFAULT_MAX): string {
  // eslint-disable-next-line no-control-regex
  let out = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '');
  out = out.replace(/<{3,}/g, '<<').replace(/>{3,}/g, '>>');
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}...[truncated]`;
  return out;
}

/**
 * Wraps page-derived text in explicit data delimiters for model prompts. The prompt's system
 * text must state that content between the delimiters is data and never instructions.
 */
export function wrapUntrusted(text: string, opts: UntrustedOptions = {}): string {
  const label = (opts.label ?? 'page').replace(/[^\w-]/g, '');
  return `<<<PAGE_DATA label=${label}>>>\n${sanitizeUntrusted(text, opts.maxLength)}\n${CLOSE}`;
}
