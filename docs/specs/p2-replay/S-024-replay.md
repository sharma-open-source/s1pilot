# S-024 · Replay mode

**Phase:** P2 · **Depends on:** S-023 · **Packages:** `@s1pilot/engine` · **Plan refs:** §2.3 Replay, §15 P2

## Goal
Re-run learned steps deterministically and fast, calling models only for AI-judged assertions.

## Scope
- `src/loop/replay-step.ts`: for each `ResolvedAction`: check pre-fingerprint (tolerant compare: same URL pattern + ≥ 80% landmark/heading overlap) → resolve locator candidates in order → execute → wait hint.
- Mismatch or locator failure → return `ReplayBreak { stepIndex, subIndex, reason: 'fingerprint'|'locator'|'action-error' }` (heal handled by S-025).
- Mode selection `chooseMode(case, env, planMode)`: `replay-only` | `replay-heal` | `explore`.
- Record `mode: 'replay'` per step in `StepResult`.

## Acceptance criteria
- [ ] Replaying TC-42 with no model configured (except verifier mock) passes.
- [ ] Replay is ≥ 5× faster than explore on fixture suite (benchmark test, logged; assert ≥ 3× in CI to avoid flakiness).
- [ ] Variant `shop.guest-button-renamed` causes a `ReplayBreak` at step 3 with reason `locator`.

## Tests
- Fixture-site tests, timing benchmark.

## Out of scope
- Healing (S-025).
