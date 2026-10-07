# S-038 · Auth setup flows (login state)

**Phase:** P3 · **Depends on:** S-032, S-015 · **Packages:** `@s1pilot/runner`, `apps/server` · **Plan refs:** §1 Environment.authSetup, §8.1 Project setup (record login once)

## Goal
Log in once per environment/role, save Playwright storage state, reuse it in every run, and refresh it when expired.

## Scope
- `AuthSetup { id, environmentId, name ('login-as-customer'), kind: 'recorded'|'flow', flowId?, storageStateArtifactId?, lastRefreshedAt, status: 'valid'|'expired'|'never', validation: { url, assertion } }`.
- Kinds:
  - `flow`: a shared step / YAML flow executed by the engine (replay/explore) at refresh time.
  - `recorded`: headed browser opened locally (`auth.record`), user logs in, presses "Done" in UI → storage state saved (encrypted at rest with vault).
- `validate(authSetup)`: open validation URL with state, run assertion; `expired` on failure.
- Runner: case precondition `auth: <name>` loads storage state; when expired, refresh once automatically; failure → case `blocked` with reason.
- tRPC `auth.list/record/finishRecording/refresh/validate/delete`.

## Acceptance criteria
- [ ] Fixture shop login flow refreshes and produces valid state; a case with `auth: login-as-customer` starts logged in.
- [ ] Expired state triggers one refresh; persistent failure → `blocked`.
- [ ] Storage state never written unencrypted to disk outside temp dirs used by the browser.

## Tests
- Integration with fixture login.

## Out of scope
- OTP via mailbox (later), UI (S-042).
