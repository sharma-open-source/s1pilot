import type { ObservedElement } from '../observer/types.js';

export type InferredAction = 'click' | 'fill' | 'selectOption' | 'check';

/**
 * Role-based action inference. `hasValue` says whether a value to enter is available:
 * textbox/searchbox/spinbutton/slider -> fill (sliders are set to a value, not clicked);
 * combobox -> fill only when a value is available (else click to open);
 * listbox/select -> selectOption; checkbox/radio/switch -> check; everything else -> click.
 */
export function inferAction(element: Pick<ObservedElement, 'role'> & { state?: ObservedElement['state'] }, hasValue: boolean): InferredAction {
  // A read-only text input (a date picker opening a calendar) is clicked, not typed into.
  if (element.state?.readonly) return 'click';
  switch (element.role) {
    case 'textbox':
    case 'searchbox':
    case 'spinbutton':
    case 'slider':
      return 'fill';
    case 'combobox':
      return hasValue ? 'fill' : 'click';
    case 'listbox':
    case 'select':
      return 'selectOption';
    case 'checkbox':
    case 'radio':
    case 'switch':
      return 'check';
    default:
      return 'click';
  }
}
