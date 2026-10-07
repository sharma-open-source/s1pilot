# S-031 · API server scaffold

**Phase:** P3 · **Depends on:** S-003 · **Packages:** `apps/server` · **Plan refs:** §9, §10

## Goal
A Fastify + tRPC server in local single-process mode, ready for routers, with health, config and typed client export.

## Scope
- `apps/server/src/`:
  - `config.ts` — zod-validated config from env/flags: `port` (5317), `dataDir` (`~/.s1pilot` or `./.s1pilot`), `dbUrl`, `artifactsDir`, `mode: 'local'|'team'`, `logLevel`.
  - `app.ts` — `buildApp(config)` Fastify instance: pino logger with redaction, CORS (dev only), `@fastify/websocket`, `@fastify/static` (serves `apps/web/dist` in production), tRPC adapter at `/trpc`, REST `GET /api/health` → `{ ok, version, mode }`.
  - `trpc/` — `createContext` (db, repos, user = local single user `{id:'local', role:'admin'}`), `router.ts` root router with `health` procedure, error formatter mapping `S1PilotError` → tRPC codes.
  - `main.ts` — start/stop with graceful shutdown.
- Export `AppRouter` type from `@s1pilot/server/router` for the web client.
- `pnpm --filter @s1pilot/server dev` with tsx watch.

## Acceptance criteria
- [ ] `GET /api/health` returns 200 with version.
- [ ] tRPC `health` callable from a typed client in tests.
- [ ] Server starts with empty data dir, creates DB and runs migrations.

## Tests
- `fastify.inject` tests; tRPC caller tests.

## Out of scope
- Domain routers (S-032+), auth (S-067).
