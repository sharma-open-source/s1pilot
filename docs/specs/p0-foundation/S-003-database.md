# S-003 · Database schema & repositories

**Phase:** P0 · **Depends on:** S-002 · **Packages:** `@s1pilot/db` · **Plan refs:** §1, §9, §10

## Goal
SQLite persistence (Drizzle) for all domain entities with typed repositories, written so Postgres can be added in S-066 without changing callers.

## Scope
- Drizzle schema (`src/schema/*.ts`) for: workspaces, projects, environments, variables, suites (nestable via parentId), test_cases, test_case_versions (full JSON snapshot per version), shared_steps, requirements, case_requirements, test_data_sets, learned_scripts, heal_proposals, test_plans, test_runs, case_results, step_results, decision_records, evidence, defects, defect_results, review_items, settings (key/value JSON).
- JSON columns for nested structures (steps, assertions, matrix) validated by domain zod on read/write.
- Migrations via `drizzle-kit` (`pnpm --filter @s1pilot/db migrate`); `openDb({ url })` creating the file and running migrations.
- Repositories (`src/repos/*.ts`), each a plain object of async functions taking `db`: `projects`, `environments`, `suites`, `cases` (create, update → bumps `version` and writes snapshot, getByKey, list with filters, nextCaseNumber), `sharedSteps`, `learnedScripts`, `plans`, `runs`, `results`, `defects`, `reviews`, `settings`.
- Transactions helper `withTx(db, fn)`.
- Seed script `pnpm --filter @s1pilot/db seed:demo` creating project `SHOP` with dev/staging/prod environments and the plan §1.2 case.

## Interfaces
```ts
export function openDb(opts: { url: string }): Db;           // url: "file:./.s1pilot/data.db" or ":memory:"
export const repos: { projects: ProjectsRepo; cases: CasesRepo; /* … */ };
```
Repos accept and return domain types (`@s1pilot/domain`), never raw rows.

## Acceptance criteria
- [ ] `openDb({url:':memory:'})` migrates and all repos work in tests.
- [ ] Updating a test case increments `version` and stores the previous snapshot; `cases.history(id)` returns versions newest first.
- [ ] Case keys auto-increment per project (`SHOP-TC-1`, `SHOP-TC-2`…), unique under concurrent inserts in one process.
- [ ] Secret variable rows store only an encrypted blob reference (column `secret_ciphertext`), never plaintext (encryption itself from S-004 — use an injected `encrypt` fn; tests use identity stub).
- [ ] Deleting a project cascades to its children.

## Tests
- Repo tests per entity against in-memory SQLite; migration test from empty DB.

## Out of scope
- Postgres driver (S-066), queue tables (S-034), artifact files (S-035).
