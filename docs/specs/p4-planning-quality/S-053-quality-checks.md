# S-053 · Accessibility & console/network health checks

**Phase:** P4 · **Depends on:** S-035 · **Packages:** `@s1pilot/runner`, `@s1pilot/engine`, `apps/web` · **Plan refs:** §3 (a11y, console/network health, API steps)

## Goal
Optional per-plan checks that turn accessibility violations, console errors and failing network requests into warnings or failures.

## Scope
- `@axe-core/playwright` scan after each step (or per unique page fingerprint to save time); config: impact threshold (`serious`+ fails, others warn), rules disabled list.
- Console health: uncaught errors / `console.error` during case → fail or warn per plan setting, allow-list regexes per project.
- Network health: 5xx responses and failed requests (excluding allow-list, third-party domains optional) → fail/warn.
- Results stored as `CheckResult { kind: 'a11y'|'console'|'network', severity, items[] }` on CaseResult; evidence JSON artifacts.
- UI: Run report "Accessibility · n" tab (violations list: rule, impact, target selector, help link) and Console/Network tabs show flagged items; warnings shown as warning pill on result.
- Defect source "from accessibility scan" supported (S-054 consumes).

## Acceptance criteria
- [ ] Fixture page with a missing form label reports an a11y violation (`label`).
- [ ] Console error injected by fixture fails the case when "Fail on console errors" is on and only warns when off.
- [ ] Checks add < 30% overhead on fixture suite with per-fingerprint scanning.

## Tests
- Fixture integration; UI component test for a11y tab.

## Out of scope
- Visual regression, performance budgets (later).
