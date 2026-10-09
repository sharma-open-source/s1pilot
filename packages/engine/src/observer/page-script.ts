/// <reference lib="dom" />
import type { LocatorCandidate } from '@s1pilot/domain';

import type { Box } from './types.js';

/** Element descriptor as produced inside the page (no id yet, box relative to its own frame viewport). */
export interface RawElement {
  role: string;
  name: string;
  text?: string;
  placeholder?: string;
  value?: string;
  state: { checked?: boolean; selected?: boolean; expanded?: boolean };
  landmark?: string;
  box: Box;
  locators: LocatorCandidate[];
  /** Set only when `collectInPage` was given a `markAttr` and this element carries it (recorder, S-060). */
  marked?: boolean;
  /** Text mode only: the block shows a pointer cursor (likely has a script click handler). */
  clickable?: boolean;
  /** Text mode only: the block intersects the viewport. */
  inView?: boolean;
}

/** Options for {@link collectInPage} (a bare number is `maxText`). */
export interface CollectOptions {
  maxText: number;
  /** `interactive` (default): controls. `text`: visible non-interactive text blocks (paragraphs, cells, headings, ...). */
  mode?: 'interactive' | 'text';
  /** Text mode: max blocks returned, in document order. Default 300. */
  maxBlocks?: number;
}

/**
 * Runs inside the page (serialised by Playwright, so it must be fully self-contained).
 * Finds visible, enabled interactive elements (incl. open shadow roots) in document order and
 * computes role, accessible name, state, landmark and locator candidates for each.
 * With `mode: 'text'` it instead returns visible text blocks that are not part of a control
 * (role `heading` or `text`), including ones scrolled out of view, so steps can refer to page text.
 */
export function collectInPage(arg: number | CollectOptions, markAttr?: string): RawElement[] {
  const opts: CollectOptions = typeof arg === 'number' ? { maxText: arg } : arg;
  const maxText = opts.maxText;
  const INTERACTIVE_ROLES =
    'button|link|tab|menuitem|checkbox|radio|combobox|option|switch|textbox|searchbox|slider|spinbutton|menuitemcheckbox|menuitemradio';
  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    'summary',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[onclick]',
    ...INTERACTIVE_ROLES.split('|').map((r) => `[role~="${r}"]`),
  ].join(',');
  const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-qa'];
  const NAME_FROM_CONTENT = new Set([
    'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch',
  ]);
  const SECRET_RE = /pass(word|wd)?|secret|token|cvv|cvc|otp|one-time|api[-_ ]?key|ssn|card[-_ ]?number|cc-/i;

  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

  const rootOf = (el: Element): Document | ShadowRoot => el.getRootNode() as Document | ShadowRoot;

  const isHidden = (el: Element): boolean => {
    const cs = getComputedStyle(el);
    return cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || el.closest('[aria-hidden="true"]') !== null;
  };

  /** Text of a subtree for name computation: skips hidden nodes and embedded form controls. */
  const subtreeText = (node: Node, seen: Set<Node>): string => {
    if (seen.has(node)) return '';
    seen.add(node);
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template') return '';
    if (isHidden(el)) return '';
    if (tag === 'img') return el.getAttribute('alt') ?? '';
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return '';
    let out = '';
    if (tag === 'slot') {
      for (const n of (el as HTMLSlotElement).assignedNodes({ flatten: true })) out += subtreeText(n, seen);
    } else {
      const kids = (el as HTMLElement).shadowRoot?.childNodes ?? el.childNodes;
      for (const n of Array.from(kids)) out += subtreeText(n, seen);
    }
    const display = getComputedStyle(el).display;
    return display.startsWith('inline') || display === 'contents' ? out : ` ${out} `;
  };

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) {
      const first = explicit.trim().split(/\s+/)[0];
      if (first) return first;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') {
      const s = el as HTMLSelectElement;
      return s.multiple || s.size > 1 ? 'listbox' : 'combobox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.hasAttribute('contenteditable')) return 'textbox';
    return 'generic';
  };

  const labelText = (el: Element): string => {
    const labels = (el as HTMLInputElement).labels;
    if (!labels || labels.length === 0) return '';
    return norm(Array.from(labels).map((l) => subtreeText(l, new Set())).join(' '));
  };

  const nameOf = (el: Element, role: string): string => {
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const root = rootOf(el);
      const parts = labelledby
        .split(/\s+/)
        .map((id) => root.getElementById(id))
        .filter((n): n is HTMLElement => n !== null)
        .map((n) => norm(subtreeText(n, new Set())));
      const joined = norm(parts.join(' '));
      if (joined) return joined;
    }
    const aria = el.getAttribute('aria-label');
    if (aria && norm(aria)) return norm(aria);
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const type = tag === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : '';
      if (type === 'button' || type === 'submit' || type === 'reset') {
        const v = (el as HTMLInputElement).value;
        if (v) return norm(v);
        if (type === 'submit') return 'Submit';
        if (type === 'reset') return 'Reset';
      }
      if (type === 'image') {
        const alt = el.getAttribute('alt');
        if (alt) return norm(alt);
      }
      const l = labelText(el);
      if (l) return l;
    } else if (NAME_FROM_CONTENT.has(role) || role === 'link') {
      const t = norm(subtreeText(el, new Set()));
      if (t) return t;
    }
    const title = el.getAttribute('title');
    if (title && norm(title)) return norm(title);
    const ph = el.getAttribute('placeholder');
    if (ph && norm(ph)) return norm(ph);
    return '';
  };

  /** Nearest landmark ancestor (crossing shadow boundaries) as `<kind>:<name>`. */
  const landmarkOf = (el: Element): string | undefined => {
    let cur: Element | null = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
    while (cur) {
      const tag = cur.tagName.toLowerCase();
      const r = cur.getAttribute('role');
      let kind: string | undefined;
      if (tag === 'dialog' || r === 'dialog' || r === 'alertdialog') kind = 'dialog';
      else if (tag === 'nav' || r === 'navigation') kind = 'nav';
      else if (tag === 'main' || r === 'main') kind = 'main';
      else if (tag === 'form' || r === 'form') kind = 'form';
      else if (r === 'region' || (tag === 'section' && (cur.hasAttribute('aria-label') || cur.hasAttribute('aria-labelledby')))) kind = 'region';
      if (kind) {
        const n = nameOf(cur, kind === 'dialog' ? 'dialog' : kind);
        const heading = kind === 'dialog' && !n ? norm(subtreeText(cur.querySelector('h1,h2,h3,h4') ?? document.createTextNode(''), new Set())) : '';
        const label = n || heading;
        return label ? `${kind}:${label}` : kind;
      }
      cur = cur.parentElement ?? ((cur.getRootNode() as ShadowRoot).host ?? null);
    }
    return undefined;
  };

  /** CSS path using the nearest unique id as anchor; descendant combinator crosses shadow roots (Playwright pierces them). */
  const cssPath = (el: Element): string => {
    let path = '';
    let sep = ' > ';
    let cur: Element | null = el;
    while (cur) {
      const root = rootOf(cur);
      const id = cur.getAttribute('id');
      const parent: Element | null = cur.parentElement;
      let seg: string;
      let anchored = false;
      if (id && root.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
        seg = `#${CSS.escape(id)}`;
        anchored = true;
      } else {
        const tag = cur.tagName.toLowerCase();
        const siblings: Element[] = parent ? Array.from(parent.children) : [];
        const self: Element = cur;
        const same = siblings.filter((c) => c.tagName === self.tagName);
        seg = same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(self) + 1})` : tag;
      }
      path = path ? seg + sep + path : seg;
      sep = ' > ';
      if (!anchored && parent) {
        cur = parent;
        continue;
      }
      if (root instanceof ShadowRoot) {
        cur = root.host;
        sep = ' ';
        continue;
      }
      break;
    }
    return path;
  };

  // Count of light-DOM elements by exact normalised text, to offer getByText only when unique.
  const textCounts = new Map<string, number>();
  for (const e of Array.from(document.body ? document.body.querySelectorAll('*') : [])) {
    const raw = e.textContent;
    if (!raw || raw.length > maxText * 4) continue;
    const t = norm(raw);
    if (!t || t.length > maxText) continue;
    if (e.children.length === 1 && norm(e.children.item(0)?.textContent ?? '') === t) continue; // wrapper
    textCounts.set(t, (textCounts.get(t) ?? 0) + 1);
  }

  if (opts.mode === 'text') {
    const maxBlocks = opts.maxBlocks ?? 300;
    const SKIP_TAGS = new Set([
      'script', 'style', 'template', 'noscript', 'svg', 'canvas', 'iframe', 'head', 'title', 'option', 'optgroup', 'datalist',
    ]);
    // Computed styles and control text lengths are cached: the pass must stay linear on deep pages.
    const styles = new Map<Element, CSSStyleDeclaration>();
    const style = (el: Element): CSSStyleDeclaration => {
      let cs = styles.get(el);
      if (!cs) {
        cs = getComputedStyle(el);
        styles.set(el, cs);
      }
      return cs;
    };
    const isInline = (el: Element): boolean => {
      const d = style(el).display;
      return d.startsWith('inline') || d === 'contents';
    };
    const controlLength = new Map<Element, number>();
    /**
     * Text of a block's own inline content; stops at block-level children (blocks of their own) and
     * form fields. `own` leaves out controls and labels too: a block only counts when it says
     * something besides the controls it holds, while `full` keeps link text inside a sentence.
     */
    const inlineText = (nodes: Iterable<Node>, inControl = false): { full: string; own: string } => {
      let full = '';
      let own = '';
      for (const n of nodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          const t = n.textContent ?? '';
          full += t;
          if (!inControl) own += t;
          continue;
        }
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        const c = n as Element;
        const tag = c.tagName.toLowerCase();
        if (SKIP_TAGS.has(tag) || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'label') continue;
        const cs = style(c);
        if (cs.display === 'none' || cs.visibility === 'hidden' || c.getAttribute('aria-hidden') === 'true') continue;
        if (tag === 'img') {
          full += ` ${c.getAttribute('alt') ?? ''} `;
          continue;
        }
        if (tag !== 'slot' && !isInline(c)) {
          full += ' ';
          own += ' ';
          continue;
        }
        const kids = tag === 'slot' ? (c as HTMLSlotElement).assignedNodes({ flatten: true }) : Array.from(c.shadowRoot?.childNodes ?? c.childNodes);
        const inner = inlineText(kids, inControl || c.matches(SELECTOR));
        full += inner.full;
        own += inner.own;
      }
      return { full, own };
    };
    const blocks: RawElement[] = [];
    const visit = (root: Document | ShadowRoot): void => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (blocks.length >= maxBlocks) return;
        if (el.shadowRoot) visit(el.shadowRoot);
        const tag = el.tagName.toLowerCase();
        // Inline runs (<b>, <span>, <a>) are part of their nearest block's text.
        if (SKIP_TAGS.has(tag) || tag === 'html' || isInline(el)) continue;
        if (el.closest('label')) continue; // a label is its control's name, already listed with the control
        // Text inside a small control is already that control's name; a huge `[onclick]` wrapper does not count.
        const control = el.closest(SELECTOR);
        if (control) {
          let len = controlLength.get(control);
          if (len === undefined) {
            len = norm(control.textContent ?? '').length;
            controlLength.set(control, len);
          }
          if (len <= maxText) continue;
        }
        const content = inlineText(Array.from(el.shadowRoot?.childNodes ?? el.childNodes));
        if (!/[\p{L}\p{N}]/u.test(content.own)) continue;
        const full = norm(content.full);
        if (full.length < 2) continue;
        if (!(el as HTMLElement).checkVisibility({ checkVisibilityCSS: true } as CheckVisibilityOptions)) continue;
        if (el.closest('[aria-hidden="true"]')) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const text = full.length > maxText ? full.slice(0, maxText) : full;
        const isHeading = /^h[1-6]$/.test(tag) || el.getAttribute('role') === 'heading';
        const d: RawElement = {
          role: isHeading ? 'heading' : 'text',
          name: text,
          text,
          state: {},
          box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          locators: [],
          inView: rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth,
        };
        if (style(el).cursor === 'pointer') d.clickable = true;
        const lm = landmarkOf(el);
        if (lm) d.landmark = lm;
        if (isHeading && full.length <= maxText) d.locators.push({ kind: 'role', value: 'heading', name: full });
        for (const a of TEST_ID_ATTRS) {
          const v = el.getAttribute(a);
          if (v) {
            d.locators.push({ kind: 'testId', value: v });
            break;
          }
        }
        if (full.length <= maxText && !(rootOf(el) instanceof ShadowRoot) && textCounts.get(full) === 1 && norm(el.textContent ?? '') === full) {
          d.locators.push({ kind: 'text', value: full });
        }
        d.locators.push({ kind: 'css', value: cssPath(el) });
        blocks.push(d);
      }
    };
    visit(document);
    return blocks;
  }

  const found: Element[] = [];
  const walk = (root: Document | ShadowRoot | Element): void => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el.matches(SELECTOR)) found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);

  const out: RawElement[] = [];
  for (const el of found) {
    if (!(el as HTMLElement).checkVisibility({ checkVisibilityCSS: true } as CheckVisibilityOptions)) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const role = roleOf(el);
    const tag = el.tagName.toLowerCase();
    const name = nameOf(el, role);
    const isControl = tag === 'input' || tag === 'select' || tag === 'textarea';
    const type = tag === 'input' ? ((el as HTMLInputElement).type || 'text').toLowerCase() : '';

    const d: RawElement = {
      role,
      name,
      state: {},
      box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      locators: [],
    };

    let text: string | undefined;
    if (!isControl) {
      const t = norm(el.textContent ?? '');
      if (t) text = t.length > maxText ? t.slice(0, maxText) : t;
    }
    if (text) d.text = text;
    const ph = el.getAttribute('placeholder');
    if (ph && isControl) d.placeholder = norm(ph);

    if (isControl && type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'reset' && type !== 'image') {
      let value = '';
      if (tag === 'select') {
        value = Array.from((el as HTMLSelectElement).selectedOptions).map((o) => norm(o.text)).join(', ');
      } else {
        value = (el as HTMLInputElement | HTMLTextAreaElement).value;
      }
      const secretLike =
        type === 'password' || SECRET_RE.test(`${el.getAttribute('name') ?? ''} ${el.getAttribute('id') ?? ''} ${el.getAttribute('autocomplete') ?? ''}`);
      if (type === 'password') {
        // Never expose password values, not even masked (their length is information too).
      } else if (value) {
        d.value = secretLike ? '••••' : value;
      }
    }

    const checked = el.getAttribute('aria-checked');
    if (type === 'checkbox' || type === 'radio') d.state.checked = (el as HTMLInputElement).checked;
    else if (checked === 'true' || checked === 'false') d.state.checked = checked === 'true';
    const sel = el.getAttribute('aria-selected');
    if (sel === 'true' || sel === 'false') d.state.selected = sel === 'true';
    const exp = el.getAttribute('aria-expanded');
    if (exp === 'true' || exp === 'false') d.state.expanded = exp === 'true';
    const lm = landmarkOf(el);
    if (lm) d.landmark = lm;

    // Locator candidates, most robust first.
    if (role !== 'generic' && name) d.locators.push({ kind: 'role', value: role, name });
    else if (role !== 'generic' && !name) d.locators.push({ kind: 'role', value: role });
    for (const a of TEST_ID_ATTRS) {
      const v = el.getAttribute(a);
      if (v) {
        d.locators.push({ kind: 'testId', value: v });
        break;
      }
    }
    const textKey = !isControl && text && text.length <= maxText && norm(el.textContent ?? '') === text ? text : undefined;
    if (textKey && !(rootOf(el) instanceof ShadowRoot) && textCounts.get(textKey) === 1) {
      d.locators.push({ kind: 'text', value: textKey });
    }
    d.locators.push({ kind: 'css', value: cssPath(el) });
    if (markAttr && el.hasAttribute(markAttr)) d.marked = true;
    out.push(d);
  }
  return out;
}
