# S-048 · `s1pilot ui` & "first test in 5 minutes" E2E

**Phase:** P3 · **Depends on:** S-040 – S-047 · **Packages:** `apps/cli`, `apps/server`, `apps/web`, e2e tests · **Plan refs:** §8 (launch), §8.2 flow 1, §15 P3 exit

## Goal
One command starts the local app; an automated E2E proves the P3 exit criterion.

## Scope
- `s1pilot ui [--port 5317] [--data-dir] [--no-open]`: starts server (API + queue + workers + static web build) in one process, opens browser.
- Packaging: web `dist` bundled into the CLI package (`apps/cli/dist/web`) so `npx s1pilot ui` works.
- E2E (`e2e/first-test.spec.ts`, Playwright against the app + fixture site + fake systemone server driven by an oracle mock):
  create project → paste fixture URL → probe model → write "Sign up with a new email and see the welcome page" (fixture `/forms` or shop signup) → Run (explore) → watch live → approve escalation → finish → learned script saved → run again → replay mode used.
- Docs: `docs/getting-started.md` with the same flow.

## Acceptance criteria
- [ ] `npx s1pilot ui` from packed tarball serves the app.
- [ ] E2E passes in CI in < 5 minutes wall-clock.
- [ ] Second run shows mode `replay` in report.

## Tests
- The E2E itself.

## Out of scope
- Plans (P4).
