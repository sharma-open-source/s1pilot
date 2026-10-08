/// <reference lib="dom" />
import type { Page } from 'playwright';

/** A form field flagged invalid, with the message(s) the page shows for it. */
export interface ValidationMessage {
  /** Accessible name of the invalid field (label, aria-label or placeholder). */
  field: string;
  message: string;
}

/** Page-level context shown to the model next to the element list. */
export interface PageContext {
  url: string;
  title: string;
  /** Visible h1-h3 texts in document order (max 10). */
  headings: string[];
  /** Visible `role=alert|status` texts (toasts, banners). */
  alerts: string[];
  /** Names of open dialogs (`<dialog open>`, `role=dialog|alertdialog`, `aria-modal`). */
  dialogs: string[];
  /** Messages for `aria-invalid` fields (from `aria-describedby`, else `aria-errormessage`). */
  validation: ValidationMessage[];
}

/** Max headings kept in a context. */
export const MAX_HEADINGS = 10;

interface RawContext {
  title: string;
  headings: string[];
  alerts: string[];
  dialogs: string[];
  validation: ValidationMessage[];
}

/** Runs inside the page (must be self-contained). */
function collectContextInPage(maxHeadings: number): RawContext {
  const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const all = (sel: string): Element[] => Array.from(document.querySelectorAll(sel)).filter(visible);
  const byIds = (ids: string | null): string =>
    norm(
      (ids ?? '')
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
  const nameOf = (el: Element): string => {
    const label = norm(el.getAttribute('aria-label'));
    if (label) return label;
    const lb = byIds(el.getAttribute('aria-labelledby'));
    if (lb) return lb;
    const id = el.getAttribute('id');
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l) return norm(l.textContent);
    }
    const wrap = el.closest('label');
    if (wrap) return norm(wrap.textContent);
    return norm(el.getAttribute('placeholder') ?? el.getAttribute('name'));
  };

  const headings = all('h1,h2,h3')
    .map((h) => norm(h.textContent))
    .filter(Boolean)
    .slice(0, maxHeadings);
  const alerts = [...new Set(all('[role=alert],[role=status]').map((a) => norm(a.textContent)).filter(Boolean))];
  const dialogs = all('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]').map((d) => {
    const heading = d.querySelector('h1,h2,h3');
    return nameOf(d) || norm(heading?.textContent) || 'dialog';
  });
  const validation: ValidationMessage[] = [];
  for (const f of all('[aria-invalid]:not([aria-invalid=false])')) {
    const message = byIds(f.getAttribute('aria-describedby')) || byIds(f.getAttribute('aria-errormessage'));
    if (message) validation.push({ field: nameOf(f), message });
  }
  return { title: document.title, headings, alerts, dialogs, validation };
}

/** Captures URL, title, headings, alerts, dialogs and validation messages of the main frame. */
export async function capturePageContext(page: Page): Promise<PageContext> {
  const raw = await page.evaluate(collectContextInPage, MAX_HEADINGS);
  return { url: page.url(), ...raw };
}
