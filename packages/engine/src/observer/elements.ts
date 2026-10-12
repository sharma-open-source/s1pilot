import type { Frame, Page } from 'playwright';

import { collectInPage, type RawElement } from './page-script.js';
import type { ObservedElement } from './types.js';

/** Max characters of visible text kept per descriptor. */
const MAX_TEXT = 120;

/** Human-readable label for a frame: its `name`, else its URL. */
function frameLabel(frame: Frame): string {
  return frame.name() || frame.url();
}

/** Offset of a (possibly nested) frame's viewport inside the main page viewport; null if not visible. */
async function frameOffset(frame: Frame): Promise<{ x: number; y: number } | null> {
  let x = 0;
  let y = 0;
  for (let f: Frame | null = frame; f?.parentFrame(); f = f.parentFrame()) {
    const handle = await f.frameElement().catch(() => null);
    const box = handle ? await handle.boundingBox() : null;
    if (!box) return null;
    x += box.x;
    y += box.y;
  }
  return { x, y };
}

/** Max text blocks captured per frame. */
const MAX_TEXT_BLOCKS = 300;

async function captureFrames(page: Page, mode: 'interactive' | 'text', prefix: string): Promise<ObservedElement[]> {
  const result: ObservedElement[] = [];
  let n = 0;
  for (const frame of page.frames()) {
    const isMain = frame === page.mainFrame();
    const offset = isMain ? { x: 0, y: 0 } : await frameOffset(frame);
    if (!offset) continue;
    let raw: RawElement[];
    try {
      raw = await frame.evaluate(collectInPage, { maxText: MAX_TEXT, mode, maxBlocks: MAX_TEXT_BLOCKS });
    } catch {
      continue; // frame navigated or detached mid-capture
    }
    for (const r of raw) {
      n += 1;
      const el: ObservedElement = {
        id: `${prefix}${n}`,
        role: r.role,
        name: r.name,
        state: { ...r.state },
        box: { x: r.box.x + Math.round(offset.x), y: r.box.y + Math.round(offset.y), w: r.box.w, h: r.box.h },
        locators: r.locators,
      };
      if (r.text !== undefined) el.text = r.text;
      if (r.placeholder !== undefined) el.placeholder = r.placeholder;
      if (r.inputType !== undefined) el.inputType = r.inputType;
      if (r.range !== undefined) el.range = r.range;
      if (r.nearLabel !== undefined) el.nearLabel = r.nearLabel;
      if (r.value !== undefined) el.value = r.value;
      if (r.landmark !== undefined) el.landmark = r.landmark;
      if (r.clickable) el.clickable = true;
      if (r.inView !== undefined) el.inView = r.inView;
      if (!isMain) el.frame = frameLabel(frame);
      result.push(el);
    }
  }
  return result;
}

/**
 * Captures the visible, enabled interactive elements of a page (including open shadow roots and
 * iframes) as stable text-first descriptors with ids `e1`, `e2`, ... in document order
 * (main frame first, then child frames in frame-tree order).
 *
 * Roles and accessible names are computed in the page: Playwright 1.63 no longer ships
 * `page.accessibility`, and a single in-page pass is also fastest and reaches shadow DOM.
 * Password values are never included; secret-looking fields are masked.
 */
export function captureElements(page: Page): Promise<ObservedElement[]> {
  return captureFrames(page, 'interactive', 'e');
}

/**
 * Captures visible non-interactive text blocks (headings, paragraphs, list items, cells, labels,
 * script-driven `div`s, ...) with ids `t1`, `t2`, ... in document order, including blocks scrolled
 * out of view (`inView: false`). Text that is already a control's name is left out.
 */
export function captureTexts(page: Page): Promise<ObservedElement[]> {
  return captureFrames(page, 'text', 't');
}
