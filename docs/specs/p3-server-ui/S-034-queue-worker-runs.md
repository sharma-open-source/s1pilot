# S-034 · Job queue, worker & run lifecycle

**Phase:** P3 · **Depends on:** S-027, S-033 · **Packages:** `apps/server`, `@s1pilot/runner`, `@s1pilot/db` · **Plan refs:** §9, §8.1 Execution

## Goal
Runs are created through the API, queued, executed by in-process workers using `runCases()`, and results persisted.

## Scope
- `@s1pilot/db`: `jobs` table + `queue` API (`enqueue`, `claim(workerId)` with lease/heartbeat, `complete`, `fail`, `cancel`) — SQLite-backed; interface `JobQueue` so pg-boss can replace it (S-066).
- `apps/server/src/worker/`: `startWorkers(n)` in-process; each claims `run-case` jobs, builds `EngineContext` from DB (environment, resolved vars, model settings, learned scripts store, review/heal stores), calls `runCases` for one case instance × env × browser, persists `CaseResult`/`StepResult`/`DecisionRecord`, emits events to an in-process event bus.
- `runs` router: `create({ projectKey, caseKeys | planId(later), environment, browser, mode, attended, buildRef? })` → expands to jobs; `list(projectKey, filters)`, `get(runId)` (summary counts), `cancel(runId)`, `rerunFailed(runId)`.
- Run status machine: `queued → running → (passed|failed|needs-review|cancelled|error)`; summary counts updated incrementally.

## Acceptance criteria
- [ ] Creating a run for TC-42 against fixture site (mock model) ends `passed` with persisted step results.
- [ ] Killing a worker mid-job → lease expiry → job retried once, then `error`.
- [ ] `cancel` stops queued jobs and aborts running ones within 5 s.
- [ ] `rerunFailed` creates a new run with only failed instances.

## Tests
- Integration tests with in-memory DB + fixture server + mock model.

## Out of scope
- Evidence files (S-035), WebSocket (S-036), plans (S-049).
