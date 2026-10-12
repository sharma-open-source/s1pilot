import type { LocatorCandidate } from '@s1pilot/domain';

/** Viewport-relative bounding box in CSS pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One element as shown to the decision model (text-first, no live handles): an interactive control
 * (`e1`, `e2`, ...) or a block of page text (`t1`, `t2`, ...; role `text` or `heading`).
 */
export interface ObservedElement {
  /** Short id (`e1`... for controls, `t1`... for text blocks), assigned in document order; stable within one capture. */
  id: string;
  /** ARIA role (explicit or implicit), e.g. `button`, `link`, `textbox`; `text` / `heading` for text blocks. */
  role: string;
  /** Accessible name (whitespace-normalised). */
  name: string;
  /** Visible text, trimmed to 120 chars. Omitted for form controls. */
  text?: string;
  placeholder?: string;
  /** `date`, `time`, `datetime-local`, `month`, `week`, `range` or `color`: inputs that accept one fixed value format. */
  inputType?: string;
  /** Sliders (native or ARIA): the value range. */
  range?: { min: number; max: number };
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
  /** Text blocks only: shows a pointer cursor, so clicking it likely does something. */
  clickable?: boolean;
  /** Text blocks only: currently inside the viewport (false = must scroll to see it). */
  inView?: boolean;
}

/** True for text blocks (role `text` / `heading`) as opposed to interactive controls. */
export function isTextBlock(e: Pick<ObservedElement, 'role'>): boolean {
  return e.role === 'text' || e.role === 'heading';
}

/** Lookup of observed elements by id, kept on the observation for executor lookup. */
export type ElementMap = ReadonlyMap<string, ObservedElement>;

/** Builds an {@link ElementMap} from a capture. */
export function indexElements(elements: readonly ObservedElement[]): ElementMap {
  return new Map(elements.map((e) => [e.id, e]));
}
