# S-032 · API: projects, environments, model settings

**Phase:** P3 · **Depends on:** S-011, S-031 · **Packages:** `apps/server` · **Plan refs:** §1, §5, §8.1 Project setup / Environments / Model settings

## Goal
CRUD for projects, environments (incl. secrets) and model settings, plus a probe endpoint for "Test connection".

## Scope
tRPC routers:
- `projects`: `list` (with counts: cases, envs, last run summary, S1 model name, status), `get(key)`, `create({name, key, baseUrl})` (creates default `dev` env), `update`, `delete`.
- `environments`: `list(projectKey)`, `get`, `create`, `update` (variables with `secret` values encrypted via vault; responses return secrets masked `{ masked: true }`), `revealSecret({envId, key})` (returns plaintext, audit-logged event, rate-limited), `delete`.
- `models`: `getSettings(projectKey | 'workspace')`, `updateSettings` (project overrides workspace; `inheritsFromWorkspace` flag), `probe(endpoint)` → `ProbeResult` (S-011), `status()` → reachability of S1/S2 for nav footer (cached 30 s).
- Data policy update within project settings.
- All inputs validated with domain zod schemas.

## Acceptance criteria
- [ ] Creating project `SHOP` then listing returns it with zero counts.
- [ ] Secrets are stored encrypted and never returned by `get`/`list`.
- [ ] `probe` against a fake systemone server returns detected adapter + capabilities.
- [ ] Project model settings fall back to workspace defaults when not overridden.

## Tests
- tRPC caller tests per procedure, including validation errors.

## Out of scope
- Auth setup flows (S-038), UI (S-041/S-042).
