# S-062 · Importers

**Phase:** P5 · **Depends on:** S-033 · **Packages:** `@s1pilot/sync`, `apps/server`, `apps/web` · **Plan refs:** §2.1 Import

## Goal
Bring existing tests in from CSV, Gherkin, TestRail/Xray/Zephyr exports and Playwright specs.

## Scope
- `@s1pilot/sync/src/import/`:
  - `csv.ts` — column mapping (title, suite, priority, tags, steps/expected as numbered lines or one row per step).
  - `gherkin.ts` — `@cucumber/gherkin`: Scenario → case; Given → preconditions/steps, When → action, Then → expected; Scenario Outline Examples → parameters.
  - `testrail.ts` (XML/CSV export), `xray.ts` (JSON), `zephyr.ts` (CSV) — mapping to cases with sections → suites.
  - `playwright-spec.ts` — parse `test()` blocks with ts-morph; each `page.getByRole(...).click()` etc. → learned-script actions; step text generated as templates; status `draft`.
- Import wizard (Test cases "Import" button, Settings › Integrations › Import): upload → detect format → mapping preview (first 10) → target suite → import report (created, skipped, errors).
- Imports idempotent by external id (`externalRef` field).

## Acceptance criteria
- [ ] Fixture files for each format import with expected counts.
- [ ] Re-importing the same file updates instead of duplicating.
- [ ] Gherkin outline produces parameters table.

## Tests
- Unit tests per importer with fixture files; e2e of wizard with CSV.

## Out of scope
- Two-way sync with TestRail.
