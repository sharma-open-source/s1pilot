// Renders site/social/card.html to site/assets/social-card.png (1280x640): the repository social preview and the
// website og:image. Needs Playwright's Chromium (`pnpm --filter @s1pilot/fixture-sites exec playwright install chromium`).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../fixtures/sites/package.json', import.meta.url));
const { chromium } = require('playwright');
const source = new URL('../site/social/card.html', import.meta.url);
const out = fileURLToPath(new URL('../site/assets/social-card.png', import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.goto(source.href, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
