/// <reference lib="dom" />
import type { Page } from 'playwright';

import type { ObservedElement } from './types.js';

/** Longest side of the Set-of-Marks image, in pixels. */
export const SOM_MAX_SIDE = 448;

/** Numbered screenshot for vision-capable models. */
export interface SomImage {
  png: Buffer;
  width: number;
  height: number;
}

const OVERLAY_ATTR = 'data-s1pilot-som';

interface Mark {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Runs in the page: adds a fixed, click-through overlay with numbered boxes. */
function addOverlay(args: { marks: Mark[]; attr: string }): void {
  const root = document.createElement('div');
  root.setAttribute(args.attr, '');
  root.style.cssText =
    'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;margin:0;padding:0;';
  for (const m of args.marks) {
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:${m.x}px;top:${m.y}px;width:${m.w}px;height:${m.h}px;border:2px solid #e11d48;box-sizing:border-box;`;
    const tag = document.createElement('span');
    tag.textContent = m.id.replace(/^e/, '');
    tag.style.cssText =
      'position:absolute;left:0;top:0;background:#e11d48;color:#fff;font:bold 11px/1 monospace;padding:1px 3px;';
    box.appendChild(tag);
    root.appendChild(box);
  }
  document.documentElement.appendChild(root);
}

function removeOverlay(attr: string): void {
  document.querySelectorAll(`[${attr}]`).forEach((n) => n.remove());
}

/** Runs in a scratch page: downscales a PNG data URL with a canvas. */
async function downscale(args: { src: string; scale: number }): Promise<{ data: string; width: number; height: number }> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = args.src;
  });
  const width = Math.max(1, Math.round(img.naturalWidth * args.scale));
  const height = Math.max(1, Math.round(img.naturalHeight * args.scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, width, height);
  return { data: canvas.toDataURL('image/png'), width, height };
}

/**
 * Takes a Set-of-Marks screenshot: numbered boxes (`1` for `e1`, ...) are overlaid on the visible
 * elements, the viewport is screenshotted, the overlay is removed (also on failure), and the image
 * is downscaled so its longest side is at most {@link SOM_MAX_SIDE} px (no native image deps: a
 * canvas in a scratch page does the resize).
 * Callers must only use this when the model supports images and the data policy allows it.
 */
export async function captureSom(page: Page, elements: readonly ObservedElement[]): Promise<SomImage> {
  const viewport = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const marks: Mark[] = elements
    .filter((e) => e.box.x < viewport.width && e.box.y < viewport.height && e.box.x + e.box.w > 0 && e.box.y + e.box.h > 0)
    .map((e) => ({ id: e.id, ...e.box }));
  await page.evaluate(addOverlay, { marks, attr: OVERLAY_ATTR });
  let shot: Buffer;
  try {
    shot = await page.screenshot({ type: 'png', scale: 'css', caret: 'initial', animations: 'allow' });
  } finally {
    await page.evaluate(removeOverlay, OVERLAY_ATTR).catch(() => undefined);
  }
  const scale = Math.min(1, SOM_MAX_SIDE / Math.max(viewport.width, viewport.height));
  if (scale === 1) return { png: shot, width: viewport.width, height: viewport.height };
  const scratch = await page.context().newPage();
  try {
    const out = await scratch.evaluate(downscale, { src: `data:image/png;base64,${shot.toString('base64')}`, scale });
    return { png: Buffer.from(out.data.slice(out.data.indexOf(',') + 1), 'base64'), width: out.width, height: out.height };
  } finally {
    await scratch.close();
  }
}
