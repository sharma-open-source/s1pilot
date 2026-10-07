# S-049 · Test plans API & query language

**Phase:** P4 · **Depends on:** S-048 · **Packages:** `@s1pilot/domain`, `apps/server` · **Plan refs:** §1.1 TestPlan, §2.2

## Goal
Persisted test plans with saved-query or manual case selection, matrix and execution settings; runs can be created from a plan.

## Scope
- Complete query grammar in `packages/domain/src/query.ts`: terms `key:value`, comparisons `priority<=P1`, `AND`/`OR`/`NOT`, parentheses, quoted values, fields: `suite`, `tags`, `priority`, `status`, `owner`, `type`, `requirement`, `learned` (`yes|no`), `lastResult`, `quarantined`. Parser → AST → SQL (Drizzle) + in-memory matcher. Clear syntax errors with position.
- `plans` router: `list`, `get`, `create`, `update`, `delete`, `preview(planDraft)` → `{ matched, learned, notLearned, quarantined, executions, estimateMin }` (estimate from avg historical durations per mode / parallelism).
- `runs.create({ planId })` expands plan: cases × parameter rows × matrix combos (skip quarantined unless `includeQuarantined`), applies plan mode/retries/parallelism/checks.
- Plans list page `/p/:key/plans` (table pattern) — page body built in S-050.

## Acceptance criteria
- [ ] Query `suite:Checkout AND priority<=P2 AND status:ready` returns expected cases (DB and in-memory agree — property test).
- [ ] Preview counts match the run that gets created.
- [ ] Prod environment combos respect environment `readOnly` (only allowed browsers, per plan rules).

## Tests
- Parser unit + property tests; API tests.

## Out of scope
- Scheduling (S-052), exit criteria evaluation (S-056).
