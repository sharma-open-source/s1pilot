import type { Page } from 'playwright';

export interface StableWaitOptions {
  /** Max time to wait for network idle (default 2000). */
  networkIdleMs?: number;
  /** Required DOM quiet period (default 300). */
  quietMs?: number;
  /** Cap for the DOM quiet wait (default 3000). */
  quietCapMs?: number;
}

/**
 * Waits for the page to settle: `domcontentloaded`, network idle (bounded) and a DOM quiet period
 * (no mutations for `quietMs`, capped). Never throws; a closed page returns immediately.
 */
export async function waitForStable(page: Page, opts: StableWaitOptions = {}): Promise<void> {
  const { networkIdleMs = 2000, quietMs = 300, quietCapMs = 3000 } = opts;
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
