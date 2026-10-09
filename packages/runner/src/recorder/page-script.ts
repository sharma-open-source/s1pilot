/// <reference lib="dom" />
import type { RawElement } from '@s1pilot/engine';

/** Configuration passed into the page (JSON). */
export interface PageRecorderConfig {
  /** Name of the context binding that receives {@link RawRecorderEvent}s. */
  binding: string;
  /** Name of the binding that answers `{ paused }` when a page (re)loads. */
  stateBinding: string;
  /** Attribute used to mark the element an event is about while its descriptor is computed. */
  markAttr: string;
  /** Id of the toolbar host element. */
  hostId: string;
  maxText: number;
}

/** Parts of the page fingerprint, computed in the page at the moment of an event (before the action takes effect). */
export interface PagePreState {
  url: string;
  controls: string[];
  landmarks: string[];
  headings: string[];
}

/** Event sent from the page to the recorder. Typed values are never included for secret-looking fields. */
export interface RawRecorderEvent {
  type: 'click' | 'fill' | 'selectOption' | 'check' | 'uncheck' | 'press' | 'expect' | 'control';
  /** `Date.now()` in the page. */
  ts: number;
  frameUrl: string;
  /** Descriptor of the acted-on element (same logic as the observer). */
  el?: RawElement;
  /** Page state right before the action. */
  pre?: PagePreState;
  /** Typed value (`fill`) or chosen option label (`selectOption`); absent when `secret`. */
  value?: string;
  secret?: boolean;
  /** Key name for `press`. */
  key?: string;
  /** Text of an `expect` event. */
  text?: string;
  /** Toolbar command of a `control` event. */
  cmd?: 'stop' | 'pause' | 'resume';
}

/**
 * Runs inside the page (serialised into an init script, so it must be self-contained). Captures user
 * actions in the capture phase and reports them through `cfg.binding`; mounts the floating toolbar
 * (Pause, Add expected result, Stop) in a closed shadow root so the observer never sees it.
 * `collect` is the observer's in-page element collector.
 */
export function installRecorder(
  cfg: PageRecorderConfig,
  collect: (maxText: number, markAttr?: string) => RawElement[],
  collectContext: (maxHeadings: number) => { headings: string[] },
): void {
  const win = window as unknown as Record<string, unknown>;
  if (win['__s1pilotRecorder']) return;
  win['__s1pilotRecorder'] = true;

  const SECRET_RE = /pass(word|code|phrase|wd)?|pwd|secret|token|cvv|cvc|otp|one-time|\bpin\b|api[-_ ]?key|ssn|card[-_ ]?(number|no)|cc-/i;
  const INTERACTIVE =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[onclick],[contenteditable=""],[contenteditable="true"],' +
    '[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=checkbox],[role=radio],[role=switch],[role=option]';
  const TEXT_TYPES = ['', 'text', 'search', 'email', 'url', 'tel', 'number', 'password'];
  let paused = false;
  let repaint = (): void => undefined;
  // Lets the server mirror pause / resume made outside the toolbar.
  win['__s1pilotSetPaused'] = (value: boolean): void => {
    paused = value;
    repaint();
  };

  const send = (event: Record<string, unknown>): void => {
    const fn = win[cfg.binding] as ((p: unknown) => Promise<unknown>) | undefined;
    if (!fn) return;
    try {
      void fn({ ...event, ts: Date.now(), frameUrl: location.href }).catch(() => undefined);
    } catch {
      /* binding gone (page closing) */
    }
  };

  const inToolbar = (e: Event): boolean => e.composedPath().some((n) => (n as Element).id === cfg.hostId);
  const targetOf = (e: Event): Element | null => {
    const t = e.composedPath()[0];
    return t instanceof Element ? t : null;
  };
  const isTextField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement => {
    if (el instanceof HTMLTextAreaElement) return true;
    return el instanceof HTMLInputElement && TEXT_TYPES.includes((el.getAttribute('type') ?? '').toLowerCase());
  };
  const isToggle = (el: Element): el is HTMLInputElement =>
    el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type);

  const labelOf = (el: Element): string => {
    const labels = (el as HTMLInputElement).labels;
    return labels ? Array.from(labels).map((l) => l.textContent ?? '').join(' ') : '';
  };
  const isSecret = (el: Element): boolean => {
    if (el instanceof HTMLInputElement && el.type === 'password') return true;
    const hay = [
      el.getAttribute('name'),
      el.getAttribute('id'),
      el.getAttribute('autocomplete'),
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      labelOf(el),
    ].join(' ');
    return SECRET_RE.test(hay);
  };

  /**
   * Descriptor of `el` (the observer's logic, `el` marked while it runs) and the fingerprint parts of the
   * page as it is right now. Computed synchronously so a navigation started by the action cannot race it.
   */
  const capture = (el?: Element): { d?: RawElement; pre?: PagePreState } => {
    if (el) el.setAttribute(cfg.markAttr, '1');
    try {
      const all = collect(cfg.maxText, cfg.markAttr);
      const d = el ? all.find((x) => x.marked === true) : undefined;
      const pre: PagePreState = {
        url: location.href,
        controls: Array.from(new Set(all.map((x) => `${x.role}:${x.name}`))),
        landmarks: Array.from(new Set(all.flatMap((x) => (x.landmark ? [x.landmark] : [])))),
        headings: collectContext(10).headings,
      };
      return d ? { d, pre } : { pre };
    } catch {
      return {};
    } finally {
      if (el) el.removeAttribute(cfg.markAttr);
    }
  };

  const lastValue = new WeakMap<Element, string>();
  const emitFill = (el: HTMLInputElement | HTMLTextAreaElement): void => {
    const value = el.value;
    if (lastValue.get(el) === value) return;
    lastValue.set(el, value);
    if (value === '') return;
    const { d, pre } = capture(el);
    if (!d) return;
    // A secret value never leaves the page.
    if (isSecret(el)) send({ type: 'fill', el: d, pre, secret: true });
    else send({ type: 'fill', el: d, pre, value });
  };

  document.addEventListener(
    'focusin',
    (e) => {
      const el = targetOf(e);
      if (el && isTextField(el) && !lastValue.has(el)) lastValue.set(el, el.value);
    },
    true,
  );

  document.addEventListener(
    'click',
    (e) => {
      if (inToolbar(e)) return;
      const t = targetOf(e);
      const el = t?.closest(INTERACTIVE);
      if (!el) return;
      // Fields are captured on change; a click only focuses them.
      if (isTextField(el) || isToggle(el) || el instanceof HTMLSelectElement) return;
      if (el instanceof HTMLInputElement && el.type === 'file') return;
      const { d, pre } = capture(el);
      if (d) send({ type: 'click', el: d, pre });
    },
    true,
  );

  document.addEventListener(
    'change',
    (e) => {
      if (inToolbar(e)) return;
      const el = targetOf(e);
      if (!el) return;
      if (isTextField(el)) {
        emitFill(el);
      } else if (isToggle(el)) {
        const { d, pre } = capture(el);
        if (d) send({ type: el.checked ? 'check' : 'uncheck', el: d, pre });
      } else if (el instanceof HTMLSelectElement) {
        const { d, pre } = capture(el);
        const label = Array.from(el.selectedOptions)
          .map((o) => (o.textContent ?? '').replace(/\s+/g, ' ').trim())
          .join(', ');
        if (d && label) send({ type: 'selectOption', el: d, pre, value: label });
      }
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (inToolbar(e)) return;
      const el = targetOf(e);
      if (!el) return;
      if (e.key === 'Enter' && isTextField(el)) {
        emitFill(el);
        // With a submit button the browser fires a click on it, which is recorded as a click.
        const form = el.form;
        const hasSubmit = form !== null && form.querySelector('button:not([type]),button[type=submit],input[type=submit]') !== null;
        if (!hasSubmit && !(el instanceof HTMLTextAreaElement)) {
          const { d, pre } = capture(el);
          if (d) send({ type: 'press', el: d, pre, key: 'Enter' });
        }
      } else if (e.key === 'Escape') {
        send({ type: 'press', pre: capture().pre, key: 'Escape' });
      }
    },
    true,
  );

  // ----- floating toolbar (top frame only) -----
  const mount = (): void => {
    if (window !== window.top || !document.documentElement || document.getElementById(cfg.hostId)) return;
    const host = document.createElement('div');
    host.id = cfg.hostId;
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    const css = document.createElement('style');
    css.textContent =
      '.bar{font:14px/1.3 system-ui,sans-serif;background:#1f2933;color:#fff;border-radius:10px;padding:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;box-shadow:0 4px 16px rgba(0,0,0,.35)}' +
      'button{min-height:36px;padding:0 12px;border-radius:6px;border:1px solid #6b7785;background:#323f4b;color:#fff;font:inherit;cursor:pointer}' +
      'button.stop{background:#b42318;border-color:#b42318}input{min-height:36px;padding:0 8px;border-radius:6px;border:1px solid #6b7785;font:inherit;width:220px}' +
      '.dot{width:10px;height:10px;border-radius:50%;background:#e5484d}.dot.paused{background:#f5a524}form{display:flex;gap:6px}[hidden]{display:none!important}';
    const make = (tag: string, text?: string, cls?: string): HTMLElement => {
      const n = document.createElement(tag);
      if (text) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    };
    const bar = make('div', undefined, 'bar');
    const dot = make('span', undefined, 'dot');
    const label = make('span', 'Recording');
    const pauseBtn = make('button', 'Pause') as HTMLButtonElement;
    const expectBtn = make('button', 'Add expected result') as HTMLButtonElement;
    const stopBtn = make('button', 'Stop', 'stop') as HTMLButtonElement;
    for (const b of [pauseBtn, expectBtn, stopBtn]) b.type = 'button';
    const form = make('form') as HTMLFormElement;
    form.hidden = true;
    const input = make('input') as HTMLInputElement;
    input.placeholder = 'Expected result';
    input.setAttribute('aria-label', 'Expected result');
    const addBtn = make('button', 'Add');
    form.append(input, addBtn);
    bar.append(dot, label, pauseBtn, expectBtn, stopBtn, form);
    root.append(css, bar);
    const paint = (): void => {
      label.textContent = paused ? 'Paused' : 'Recording';
      dot.className = paused ? 'dot paused' : 'dot';
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    };
    repaint = paint;
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      paint();
      send({ type: 'control', cmd: paused ? 'pause' : 'resume' });
    });
    expectBtn.addEventListener('click', () => {
      form.hidden = !form.hidden;
      if (!form.hidden) input.focus();
    });
    stopBtn.addEventListener('click', () => send({ type: 'control', cmd: 'stop' }));
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = input.value.trim();
      if (text) send({ type: 'expect', text });
      input.value = '';
      form.hidden = true;
    });
    document.documentElement.append(host);
    const ask = win[cfg.stateBinding] as (() => Promise<{ paused: boolean }>) | undefined;
    if (ask) {
      void ask()
        .then((s) => {
          paused = s.paused;
          paint();
        })
        .catch(() => undefined);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
