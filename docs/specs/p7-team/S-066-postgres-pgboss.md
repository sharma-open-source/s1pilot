# S-066 · Postgres & pg-boss (team mode data layer)

**Phase:** P7 · **Depends on:** S-052 · **Packages:** `@s1pilot/db`, `apps/server` · **Plan refs:** §9 Team mode, §10

## Goal
Run the server against Postgres with a pg-boss queue, selected by config, without changing repository callers.

## Scope
- Drizzle Postgres schema mirroring SQLite schema (shared definitions where possible via column helpers); separate migration folders `migrations/sqlite`, `migrations/pg`.
- `openDb({ url: 'postgres://…' })` chooses driver (`postgres` / `node-postgres`).
- `PgBossQueue implements JobQueue` (S-034 interface).
- Data migration tool: `s1pilot admin migrate-sqlite-to-pg --from file:… --to postgres://…` (copies all tables, preserves ids).
- Docker Compose `deploy/compose.team.yml`: server, worker, postgres, minio (for S-068).
- CI matrix runs repo tests against both SQLite and Postgres (service container).

## Acceptance criteria
- [ ] Full test suite passes on both backends.
- [ ] Migration tool copies a seeded SQLite DB with identical counts.
- [ ] Two server instances share the pg-boss queue without double-processing.

## Tests
- Repo tests parametrised by backend; queue concurrency test.

## Out of scope
- Auth (S-067), S3 (S-068).
