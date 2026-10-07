# S-016 · Text input resolution

**Phase:** P1 · **Depends on:** S-004, S-006, S-015 · **Packages:** `@s1pilot/engine` · **Plan refs:** §4.1, §6 Text input

## Goal
When an action needs text, pick the right test-data/variable key with System 1; fall back to System 2 or the human; secrets stay as references.

## Scope
- `src/decide/inputs.ts`: `resolveInput({ element, step, vars: ResolvedVars, params, s1, s2?, human? }) → { valueRef: string } | { literal: string, source: 's2'|'human' } | { none: true }`.
  - Candidates: step `inputs` (if listed, restrict to them) + parameters + environment variables (key names only, secrets shown as `«secret»` key names).
  - S1 `choice` over keys + `none_fits` with criteria "the field labelled <name> (<placeholder>) should receive…".
  - `none_fits` → S2 (if configured) asked to produce a value given the step text (never for password/secret-looking fields) → else human hook → else `{none}`.
- Value refs: `var:shipping_zip`, `param:size`, `secret:customer_password`, `literal:<hash>` (literal stored in run-scoped map).

## Acceptance criteria
- [ ] Shipping form on `/shop` resolves name and zip fields to `var:shipping_name`, `var:shipping_zip` with the mock model.
- [ ] Secret values never appear in the S1/S2 request payload (spy on mock).
- [ ] Password fields never go to S2.

## Tests
- Unit tests with mock S1/S2; fixture test on shipping form.

## Out of scope
- Human UI for entering a value (S-037).
