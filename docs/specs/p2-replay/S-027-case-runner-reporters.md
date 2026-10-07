# S-027 · Case runner & JUnit/JSON reporters

**Phase:** P2 · **Depends on:** S-024, S-025, S-026 · **Packages:** `@s1pilot/runner`, `@s1pilot/reporters`, `apps/cli` · **Plan refs:** §2.3, §2.7 Exports, §12

## Goal
One reusable `runCases()` orchestration (used by CLI now and the server worker in S-034) plus machine-readable reports.

## Scope
- `@s1pilot/runner/src/run-cases.ts`: `runCases({ cases, environment, browser, mode, models, stores, emit, attended, out }) → RunSummary`:
  - browser/context lifecycle (fresh context per case, storage state from auth setup when available — S-038 hook interface now, default none),
  - expand parameters → choose mode → replay/heal/explore → verify → `CaseResult`s,
  - sequential for now with `parallelism` option implemented via worker pool of browser contexts (default 1).
- `@s1pilot/reporters`: `junit.ts` (one testsuite per suite, testcase per case instance; failure message = failed assertion summary; `needs-review` → `<skipped message="needs-review">` configurable), `json.ts` (full `RunSummary` incl. step results/decisions, schema-validated).
- CLI `run` switches to `runCases` and gains `--mode replay-heal|explore|replay-only`, `--reporter junit,json`, `--parallel n`.

## Acceptance criteria
- [ ] CLI run over fixture suite writes valid JUnit XML (validated against schema in tests) and JSON.
- [ ] Second CLI run of the same suite uses replay automatically.
- [ ] `--parallel 2` runs two cases concurrently with isolated contexts.

## Tests
- Runner integration tests; reporter golden-file tests.

## Out of scope
- HTML report (S-028), DB persistence (S-034).
