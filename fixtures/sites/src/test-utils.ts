import { chromium, type Browser, type Page } from 'playwright';

import { startFixtureServer, type FixtureOptions, type FixtureServer } from './index.js';

export interface Session {
  page: Page;
  server: FixtureServer;
  /** Base URL of the fixture server. */
  base: string;
  close(): Promise<void>;
}

/** Launches headless Chromium (share one per test file). */
export function launch(): Promise<Browser> {
  return chromium.launch();
}

/** Starts a fixture server with the given bugs/variant and opens a fresh page against it. */
export async function open(browser: Browser, options: FixtureOptions = {}): Promise<Session> {
  const server = await startFixtureServer(options);
  const context = await browser.newContext();
  const page = await context.newPage();
  return {
    page,
    server,
    base: server.url,
    close: async () => {
      await context.close();
      await server.close();
    },
  };
}

/** Removes the per-request `window.__FX__` flags line so pages can be compared across flag sets. */
export function normalise(html: string): string {
  return html.replace(/<script>window\.__FX__ = .*?;<\/script>\n?/, '');
}

/** The plan §1.2 guest checkout, hand-coded. Returns the page at the payment step (or wherever it ends). */
export async function guestCheckout(page: Page, base: string, zip = '94105'): Promise<void> {
  await page.goto(`${base}/shop`);
  await page.getByLabel('Search products').fill('t-shirt');
  await page.getByLabel('Search products').press('Enter');
  await page.getByRole('link', { name: 'Classic Tee' }).click();
  await page.getByLabel('Blue').check();
  await page.getByLabel('M', { exact: true }).check();
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await page.getByRole('link', { name: /^Cart/ }).click();
  await page.getByRole('link', { name: 'Checkout', exact: true }).click();
  await page.getByRole('button', { name: 'Guest checkout' }).click();
  await page.getByLabel('Full name').fill('Alex Doe');
  await page.getByLabel('ZIP code').fill(zip);
  await page.getByRole('button', { name: 'Continue to payment' }).click();
}
