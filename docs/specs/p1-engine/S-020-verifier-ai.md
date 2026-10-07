# S-020 · Verifier: AI-judged assertions & verdict policy

**Phase:** P1 · **Depends on:** S-019 · **Packages:** `@s1pilot/engine` · **Plan refs:** §2.4, §4.5, §16

## Goal
Judge each step's `expected` text with System 1 and combine with deterministic checks into a step/case verdict.

## Scope
- `src/verify/ai.ts`: after the step, capture post-state; ask `noul`: `"Is this scenario one where: <expected>?"`; optional screenshot per data policy; dual-order (repeat with negated phrasing "…where it is NOT true that…" and invert) when the case is P0 or assertion marked `critical`.
- `src/verify/policy.ts`: `verdictFor({ pTrue, thresholds:{pass, fail}, deterministic: AssertionResult[], priority, allowAiOnlyPassForP0 })`:
  - any deterministic failed → `failed`;
  - AI `pTrue ≥ pass` → passed; `≤ fail` → failed; between → `needs-review`;
  - P0 with only AI evidence and `allowAiOnlyPassForP0=false` → `needs-review` instead of passed.
- Store `AssertionResult { kind:'ai'|'deterministic', description, verdict, pTrue?, model?, dualOrderAgreed? }` on `StepResult`.
- Case verdict = worst step verdict (`failed` > `blocked` > `needs-review` > `passed`).

## Acceptance criteria
- [ ] With seeded bug `shop.badge-wrong-count` and mock judging correctly, step 2 fails.
- [ ] Policy table tests including P0 rule.
- [ ] Probabilities and model id are stored for every AI verdict.

## Tests
- Unit (policy), fixture integration (verifier with mock).

## Out of scope
- Deterministic assertion implementations (S-021), review queue (S-047), calibration (S-058).
