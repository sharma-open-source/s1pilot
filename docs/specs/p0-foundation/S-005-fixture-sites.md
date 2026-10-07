# S-005 · Fixture sites

**Phase:** P0 · **Depends on:** S-001 · **Packages:** `fixtures/sites` · **Plan refs:** §14

## Goal
Small, deterministic demo web apps used by engine tests, evals and UI demos, each with toggleable **seeded bugs** and UI variants (to test healing).

## Scope
- `fixtures/sites/` package `@s1pilot/fixture-sites` exporting `startFixtureServer({ port?, bugs?: string[], variant?: string }) → { url, close }` (plain Node `http` + static HTML/vanilla JS, no build step).
- Sites (each under its own path):
  - `/shop`: search, product page (colour/size), cart with badge (`role=status`), guest checkout (shipping form: name, zip), payment step, promo code, login.
  - `/settings`: profile form, toggles, save with toast, delete account dialog (sensitive action).
  - `/forms`: validation-heavy form (required, email, zip), select, checkbox, radio, date.
  - `/mail`: inbox list, open message, OTP code display.
- Seeded bugs (query/header or server option): `shop.zip-validation-missing`, `shop.cart-empties-on-reload`, `shop.badge-wrong-count`, `forms.error-not-shown`, `settings.save-silently-fails`.
- Variants (for heal tests): `shop.guest-button-renamed` ("Guest checkout" → "Checkout as guest"), `shop.size-picker-dropdown`, `shop.promo-in-accordion`.
- Ground-truth file `fixtures/sites/ground-truth.json`: per site, list of cases (plan-§1.2 YAML) and expected verdict per bug set.
- `pnpm --filter @s1pilot/fixture-sites dev` serves on :4400 for manual inspection.

## Acceptance criteria
- [ ] Starting with no bugs, a Playwright script can complete the plan §1.2 guest checkout manually-coded.
- [ ] Each seeded bug changes behaviour observably and only in the documented way.
- [ ] Each variant changes only the documented element.
- [ ] Server start/stop in < 200 ms; usable in parallel tests on random ports.

## Tests
- Playwright smoke test per site, per bug, per variant (hand-written selectors).

## Out of scope
- AI-driven tests on these sites (S-019+), eval runner (S-030).
