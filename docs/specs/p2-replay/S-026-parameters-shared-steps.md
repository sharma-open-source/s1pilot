# S-026 · Parameters & shared steps

**Phase:** P2 · **Depends on:** S-022 · **Packages:** `@s1pilot/engine`, `@s1pilot/sync` · **Plan refs:** §1 Shared steps, Test data sets, §1.2 parameters/preconditions

## Goal
Data-driven cases (one execution per parameter row) and reusable flows (shared steps / preconditions) work in all modes.

## Scope
- `src/expand/parameters.ts`: `expandCase(case) → CaseInstance[]` (one per parameter row, or one when none); `{param}` placeholders substituted into action/expected text for the model while keeping `param:` refs for inputs; instance label `blue / M`.
- Test data sets: parameters may reference `dataset: addresses.csv` (CSV/JSON loader, per environment) → rows.
- `src/expand/shared.ts`: steps with `sharedStepId` (or YAML `flow: <name>` with args) are inlined with `{arg}` substitution; trace keeps `sharedStepId` per inlined step for heal impact.
- Preconditions `flow:` run before step 1 (failures → case `blocked`, not `failed`).
- YAML: `.s1pilot/flows/<name>.yaml`, `.s1pilot/data/<name>.csv|json`.

## Acceptance criteria
- [ ] TC-42 with 2 parameter rows yields 2 case results labelled `blue / M`, `black / L`.
- [ ] `clear-cart` flow precondition runs before steps; its failure → `blocked`.
- [ ] Learned scripts keyed per instance where actions differ (selectOption values via `param:` refs keep one script).

## Tests
- Unit tests for expansion; fixture integration.

## Out of scope
- Shared steps UI (later spec under P3/P4 patterns).
