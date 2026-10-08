import { createHash } from 'node:crypto';

import type { Redactor } from '@s1pilot/domain';
import type { Page } from 'playwright';

import { capturePageContext, type PageContext } from './context.js';
import { captureElements } from './elements.js';
import type { ActionHistory, HistoryEntry } from './history.js';
import { captureSom, type SomImage } from './som.js';
import { indexElements, type ElementMap, type ObservedElement } from './types.js';

/** A complete view of the page for one decision. */
export interface Observation {
  context: PageContext;
  elements: ObservedElement[];
  /** Lookup by element id, for the executor. */
  elementMap: ElementMap;
  /** Last K actions, oldest first. */
  history: HistoryEntry[];
  /** Numbered screenshot; only present when requested and allowed. */
  som?: SomImage;
}

/** Options for {@link observer.capture}. */
export interface CaptureOptions {
  history?: ActionHistory;
  /** Take a Set-of-Marks screenshot. Only honoured when both flags below are true. */
  som?: boolean;
  /** Model profile `supportsImages`. */
  supportsImages?: boolean;
  /** Project data policy allows sending screenshots to the model. */
  allowImages?: boolean;
}

/** Options for {@link serializeObservation}. */
export interface SerializeOptions {
  /** Max element lines; extra elements are summarised as a count. Default: all. */
  maxElements?: number;
  /** Applied to every piece of page-derived text. */
  redactor: Redactor;
}

const MAX_NAME = 80;

/** Page observer entry point. */
export const observer = {
  /** Captures elements, page context, recent history and (if allowed) a Set-of-Marks screenshot. */
  async capture(page: Page, opts: CaptureOptions = {}): Promise<Observation> {
    const [context, elements] = await Promise.all([capturePageContext(page), captureElements(page)]);
    const obs: Observation = {
      context,
      elements,
      elementMap: indexElements(elements),
      history: opts.history?.recent() ?? [],
    };
    if (opts.som && opts.supportsImages && opts.allowImages) obs.som = await captureSom(page, elements);
    return obs;
  },
};

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function landmarkName(landmark: string): string {
  const i = landmark.indexOf(':');
  return i >= 0 && i < landmark.length - 1 ? landmark.slice(i + 1) : landmark;
}

/**
 * Renders an observation as compact text for models. Page text is data, not instructions: it is
 * redacted and only ever appears inside quoted/labelled lines. Element lines look like
 * `e3 [button] "Checkout as guest" @order summary`.
 */
export function serializeObservation(obs: Observation, opts: SerializeOptions): string {
  const r = (s: string, max = 200): string => opts.redactor.redact(clip(s, max));
  const out: string[] = [];
  const c = obs.context;
  out.push(`url: ${r(c.url, 300)}`);
  out.push(`title: ${r(c.title)}`);
  if (c.headings.length) out.push(`headings: ${c.headings.map((h) => JSON.stringify(r(h, 100))).join(' | ')}`);
  for (const d of c.dialogs) out.push(`dialog: ${JSON.stringify(r(d, 100))}`);
  for (const a of c.alerts) out.push(`alert: ${JSON.stringify(r(a))}`);
  for (const v of c.validation) out.push(`invalid: ${JSON.stringify(r(v.field, 60))} - ${JSON.stringify(r(v.message))}`);
  if (obs.history.length) {
    out.push('recent actions:');
    for (const h of obs.history) {
      out.push(`  #${h.stepIndex} ${r(h.action, 40)}${h.target ? ` ${JSON.stringify(r(h.target, 60))}` : ''} -> ${r(h.result, 80)}`);
    }
  }
  const max = opts.maxElements ?? obs.elements.length;
  out.push('elements:');
  for (const e of obs.elements.slice(0, max)) {
    let line = `${e.id} [${e.role}] ${JSON.stringify(r(e.name, MAX_NAME))}`;
    if (e.value !== undefined && e.value !== '') line += ` value=${JSON.stringify(r(e.value, 60))}`;
    else if (e.placeholder) line += ` placeholder=${JSON.stringify(r(e.placeholder, 60))}`;
    const states = Object.entries(e.state)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => (v === true ? k : `${k}=${String(v)}`));
    if (states.length) line += ` (${states.join(',')})`;
    if (e.landmark) line += ` @${r(landmarkName(e.landmark), 60)}`;
    if (e.frame) line += ` [frame ${r(e.frame, 40)}]`;
    out.push(line);
  }
  if (obs.elements.length > max) out.push(`... ${obs.elements.length - max} more elements omitted`);
  return out.join('\n');
}

/** Collapses ids, numbers and long tokens in a path so `/orders/123` and `/orders/456` match. */
function pathPattern(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url;
  }
  return path
    .split('/')
    .map((seg) => (/^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || /^[\w-]{20,}$/.test(seg) ? ':id' : seg))
    .join('/');
}

function shortHash(material: string, len: number): string {
  return createHash('sha256').update(material).digest('hex').slice(0, len);
}

/**
 * Stable structural fingerprint of the page: `<path>.<controls>.<tokens>` where `path` hashes the
 * URL path pattern, `controls` hashes the sorted role/name pairs of interactive elements, and
 * `tokens` lists short hashes of the landmarks and headings (comma separated). Equal across
 * reloads of the same page; changes when a control is renamed or removed. Replay compares
 * fingerprints tolerantly with `fingerprintsMatch` (same path and at least 80% token overlap).
 */
export function pageFingerprint(obs: Observation): string {
  const landmarks = new Set<string>();
  const controls = new Set<string>();
  for (const e of obs.elements) {
    if (e.landmark) landmarks.add(e.landmark);
    controls.add(`${e.role}:${e.name}`);
  }
  const tokens = new Set<string>();
  for (const l of landmarks) tokens.add(shortHash(`L:${l}`, 6));
  for (const h of obs.context.headings) tokens.add(shortHash(`H:${h}`, 6));
  return [
    shortHash(pathPattern(obs.context.url), 8),
    shortHash(JSON.stringify([...controls].sort()), 8),
    [...tokens].sort().join(','),
  ].join('.');
}

/** Minimum landmark/heading overlap for {@link fingerprintsMatch}. */
export const FINGERPRINT_OVERLAP = 0.8;

/**
 * Tolerant comparison of two {@link pageFingerprint}s: identical, or the same URL pattern with at
 * least 80% landmark/heading overlap (intersection over the larger set; two empty sets match).
 * Fingerprints in another format (older scripts) only match when equal.
 */
export function fingerprintsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = a.split('.');
  const pb = b.split('.');
  if (pa.length !== 3 || pb.length !== 3 || pa[0] !== pb[0]) return false;
  const ta = new Set((pa[2] ?? '').split(',').filter(Boolean));
  const tb = new Set((pb[2] ?? '').split(',').filter(Boolean));
  const larger = Math.max(ta.size, tb.size);
  if (larger === 0) return true;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / larger >= FINGERPRINT_OVERLAP;
}
