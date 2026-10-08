/** Seeded bugs: each changes exactly one behaviour of one site. */
export const BUG_IDS = [
  'shop.zip-validation-missing',
  'shop.cart-empties-on-reload',
  'shop.badge-wrong-count',
  'forms.error-not-shown',
  'settings.save-silently-fails',
] as const;
export type BugId = (typeof BUG_IDS)[number];

/** UI variants: each changes exactly one element, to exercise healing. */
export const VARIANT_IDS = [
  'shop.guest-button-renamed',
  'shop.size-picker-dropdown',
  'shop.promo-in-accordion',
] as const;
export type VariantId = (typeof VARIANT_IDS)[number];

/** Bugs and variants active for one request. */
export interface Flags {
  bugs: ReadonlySet<string>;
  variants: ReadonlySet<string>;
}

/** Parses a comma-separated list, keeping only ids from `known` (or throwing when `strict`). */
export function parseList(raw: string | undefined, known: readonly string[], strict: boolean): string[] {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = items.filter((item) => !known.includes(item));
  if (strict && unknown.length > 0) {
    throw new Error(`Unknown fixture flag(s): ${unknown.join(', ')}. Known: ${known.join(', ')}`);
  }
  return items.filter((item) => known.includes(item));
}

/** Reads one cookie value from a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
