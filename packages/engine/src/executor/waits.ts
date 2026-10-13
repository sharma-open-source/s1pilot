import type { Page } from 'playwright';

export interface StableWaitOptions {
  /** Max time to wait for network idle (default 2000). */
  networkIdleMs?: number;
  /** Required DOM quiet period (default 300). */
  quietMs?: number;
  /** Cap for the DOM quiet wait (default 3000). */
  quietCapMs?: number;
  /** Max time to wait for a visible loading indicator to go away (default {@link BUSY_CAP_MS}). */
  busyCapMs?: number;
}

/** Default cap for {@link waitWhileBusy}. */
export const BUSY_CAP_MS = 10_000;
const BUSY_POLL_MS = 100;

/**
 * Whether the page shows a loading indicator: an `aria-busy` region, an indeterminate progress bar,
 * a spinner/loader element, or a short "Loading…" / "Please wait" text. Runs in the page.
 */
function pageIsBusy(): boolean {
  const visible = (el: Element): boolean => {
    if (el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.opacity !== '0';
  };
  const selector =
    '[aria-busy="true"], [role="progressbar"]:not([aria-valuenow]), progress:not([value]), .spinner, .loader, [class*="spinner" i], [data-loading="true"]';
  if (Array.from(document.querySelectorAll(selector)).some(visible)) return true;
  if (!document.body) return false;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const text = /^(loading|please wait)\s*(\.{0,3}|…)$/i;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue?.trim() ?? '';
    if (value.length > 0 && value.length <= 16 && text.test(value) && node.parentElement && visible(node.parentElement)) return true;
  }
  return false;
}

/**
 * Waits while the page shows a loading indicator (see `pageIsBusy`), up to `capMs`.
 * Returns whether it had to wait. Never throws: navigations and closed pages end the wait.
 */
export async function waitWhileBusy(page: Page, capMs = BUSY_CAP_MS): Promise<boolean> {
  const end = Date.now() + capMs;
  let waited = false;
  while (Date.now() < end) {
    const busy = await page.evaluate(pageIsBusy).catch(() => false);
    if (!busy) return waited;
    waited = true;
    await new Promise((resolve) => setTimeout(resolve, BUSY_POLL_MS));
  }
  return waited;
}

/**
 * Waits for the page to settle: `domcontentloaded`, network idle (bounded), a DOM quiet period
 * (no mutations for `quietMs`, capped) and no visible loading indicator (`busyCapMs` in total).
 * Never throws; a closed page returns immediately.
 */
export async function waitForStable(page: Page, opts: StableWaitOptions = {}): Promise<void> {
  const { networkIdleMs = 2000, quietMs = 300, quietCapMs = 3000, busyCapMs = BUSY_CAP_MS } = opts;
  const busyEnd = Date.now() + busyCapMs;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: quietCapMs });
    await page.waitForLoadState('networkidle', { timeout: networkIdleMs }).catch(() => undefined);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.evaluate(
          ([quiet, cap]) =>
            new Promise<void>((resolve) => {
              let timer = setTimeout(done, quiet);
              const capTimer = setTimeout(done, cap);
              const mo = new MutationObserver(() => {
                clearTimeout(timer);
                timer = setTimeout(done, quiet);
              });
              mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
              function done(): void {
                mo.disconnect();
                clearTimeout(timer);
                clearTimeout(capTimer);
                resolve();
              }
            }),
          [quietMs, quietCapMs] as const,
        );
        // A loader can sit still (CSS-only spinner): wait for it to go, then let the new content render.
        if (await waitWhileBusy(page, busyEnd - Date.now())) {
          await page.waitForLoadState('domcontentloaded', { timeout: quietCapMs });
          continue;
        }
        return;
      } catch {
        // Execution context destroyed by a navigation: wait for the new document and retry.
        await page.waitForLoadState('domcontentloaded', { timeout: quietCapMs });
      }
    }
  } catch {
    // Page closed or load state never reached: nothing more to wait for.
  }
}
