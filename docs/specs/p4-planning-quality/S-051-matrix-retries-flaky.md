# S-051 · Matrix runs, retries, flaky detection & quarantine

**Phase:** P4 · **Depends on:** S-049 · **Packages:** `apps/server`, `@s1pilot/runner` · **Plan refs:** §2.2 Matrix, §2.5

## Goal
Plans run across environments × browsers × devices in parallel with retries; flakiness is detected, scored and managed.

## Scope
- Worker honours `browser` (chromium/firefox/webkit) and `device` (Playwright device descriptors) per job; parallelism = plan setting capped by server `maxWorkers`.
- Retries: failed instance retried up to `retries`; pass after retry → verdict `flaky` (attempts stored, all evidence kept).
- Flakiness score per case = flaky or alternating outcomes over last N=20 executions (same env/browser), stored on case; `cases.flaky(projectKey)` top list.
- Quarantine: `cases.quarantine/unquarantine(key, reason)`; quarantined cases excluded from plan runs by default and listed at `/p/:key/cases?q=quarantined:yes` ("Quarantine list").
- Run summary counts flaky separately.

## Acceptance criteria
- [ ] Fixture site with injected 50% flaky behaviour yields `flaky` after retry.
- [ ] Matrix 2 envs × 3 browsers creates 6 instances per case and they run in parallel up to limit.
- [ ] Quarantined case skipped and reported as `skipped (quarantined)`.

## Tests
- Integration tests with fixture flakiness toggle (add `shop.flaky-badge` to S-005 if needed).

## Out of scope
- Analytics UI (S-057).
