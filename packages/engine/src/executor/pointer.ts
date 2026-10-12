import type { Locator, Page } from 'playwright';

/**
 * Drags `source` onto `target`. Playwright's `dragTo` drives HTML5 drag and drop as well as
 * mouse-based libraries; when it throws, a manual press-move-release in small steps is tried.
 */
export async function dragOnto(page: Page, source: Locator, target: Locator, timeout: number): Promise<void> {
  try {
    await source.dragTo(target, { timeout });
    return;
  } catch {
    // fall through to the manual gesture
  }
  await source.scrollIntoViewIfNeeded({ timeout });
  const from = await source.boundingBox({ timeout });
  const to = await target.boundingBox({ timeout });
  if (!from || !to) throw new Error('Drag source or drop target has no visible box');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** Upper bound on how long a click may take to open a native file chooser. */
const FILE_CHOOSER_WAIT_MS = 3000;

/**
 * Sets `path` as the file of the upload control behind `target`:
 * 1. `target` is an `<input type="file">`, or contains one / is the label of one: set it directly
 *    (works for hidden inputs inside drop zones);
 * 2. otherwise click `target` and answer the file chooser it opens ("browse" links);
 * 3. otherwise the nearest file input among `target`'s ancestors (up to 6 levels).
 */
export async function uploadVia(page: Page, target: Locator, path: string, timeout: number): Promise<void> {
  const own = await target.evaluateHandle((el) => {
    if (el instanceof HTMLInputElement && el.type === 'file') return el;
    const inner = el.querySelector('input[type="file"]');
    if (inner) return inner;
    if (el instanceof HTMLLabelElement && el.control instanceof HTMLInputElement && el.control.type === 'file') return el.control;
    return null;
  });
  const direct = own.asElement();
  if (direct) {
    await direct.setInputFiles(path, { timeout });
    return;
  }

  const chooser = page.waitForEvent('filechooser', { timeout: FILE_CHOOSER_WAIT_MS }).catch(() => undefined);
  await target.click({ timeout });
  const fc = await chooser;
  if (fc) {
    await fc.setFiles(path, { timeout });
    return;
  }

  const near = await target.evaluateHandle((el) => {
    let cur: Element | null = el.parentElement;
    for (let depth = 0; depth < 6 && cur; depth += 1) {
      const inputs = cur.querySelectorAll('input[type="file"]');
      if (inputs.length === 1) return inputs[0] as HTMLInputElement;
      if (inputs.length > 1) return null;
      cur = cur.parentElement;
    }
    return null;
  });
  const input = near.asElement();
  if (!input) throw new Error('No file input found for this upload control');
  await input.setInputFiles(path, { timeout });
}
