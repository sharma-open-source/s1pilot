# S-021 · Deterministic assertions

**Phase:** P1 · **Depends on:** S-015 · **Packages:** `@s1pilot/engine` · **Plan refs:** §2.4

## Goal
Implement every non-AI `Assertion` type from S-002 with clear failure messages.

## Scope
- `src/verify/deterministic.ts`: `runAssertion(page, assertion, ctx) → AssertionResult` for `urlMatches` (regex or glob), `titleContains`, `elementVisible`, `elementText` (`contains|equals|matches`), `elementValue`, `elementCount` (`eq|gte|lte`), `responseStatus` (captured during step via `page.on('response')`, by URL pattern), `noConsoleErrors` (captured during step, allow-list), `downloadExists` (name pattern), `apiCheck` (Playwright `request` context: method, path, expected status/JSON path value).
- Element targeting by `{ role, name? , text?, testId? }` → Playwright locators; auto-wait up to 5 s.
- Human-readable summary string per assertion (`text(status) ⊇ "1"`, `url ~ /checkout/payment`) — used in UI tags.

## Acceptance criteria
- [ ] Each assertion type has pass + fail tests on fixture sites.
- [ ] Failure message includes expected vs actual (`expected url ~ /checkout/payment, got /checkout/shipping`).
- [ ] `summary()` strings match the forms shown in the wireframe Case editor.

## Tests
- Fixture-site tests.

## Out of scope
- a11y and global console/network checks (S-053).
