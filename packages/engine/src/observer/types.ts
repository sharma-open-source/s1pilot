import type { LocatorCandidate } from '@s1pilot/domain';

/** Viewport-relative bounding box in CSS pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One interactive element as shown to the decision model (text-first, no live handles). */
export interface ObservedElement {
  /** Short id (`e1`, `e2`, ...), assigned in document order; stable within one capture. */
  id: string;
  /** ARIA role (explicit or implicit), e.g. `button`, `link`, `textbox`. */
  role: string;
  /** Accessible name (whitespace-normalised). */
  name: string;
  /** Visible text, trimmed to 120 chars. Omitted for form controls. */
  text?: string;
  placeholder?: string;
  /** Current value; omitted for password fields and masked for secret-like fields. */
  value?: string;
  state: { checked?: boolean; selected?: boolean; expanded?: boolean; disabled?: false };
  /** Nearest landmark as `<kind>:<name>` (kinds: dialog, nav, main, form, region). */
  landmark?: string;
  box: Box;
  /** Locator candidates, most robust first. */
  locators: LocatorCandidate[];
  /** Name (or url) of the iframe the element lives in; absent for the main frame. */
  frame?: string;
}

/** Lookup of observed elements by id, kept on the observation for executor lookup. */
export type ElementMap = ReadonlyMap<string, ObservedElement>;

/** Builds an {@link ElementMap} from a capture. */
export function indexElements(elements: readonly ObservedElement[]): ElementMap {
  return new Map(elements.map((e) => [e.id, e]));
}
