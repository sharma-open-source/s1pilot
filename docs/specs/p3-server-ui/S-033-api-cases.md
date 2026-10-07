# S-033 · API: suites, test cases, versions

**Phase:** P3 · **Depends on:** S-032 · **Packages:** `apps/server` · **Plan refs:** §1, §2.1, §8.1 Test design

## Goal
Everything the Test cases list and Case editor need from the backend.

## Scope
tRPC routers:
- `suites`: `tree(projectKey)` (nested with case counts), `create`, `rename`, `move`, `delete` (only empty or with `moveCasesTo`).
- `cases`: `list({projectKey, suiteId?, query?, page, pageSize, sort})` — query language subset now: `tags:`, `priority<=`, `status:`, `owner:`, free text (title/key); full grammar in S-049 reuses the same parser module `packages/domain/src/query.ts` (create it here). Row includes learned-script status per env and last result.
  `get(key)`, `create`, `update` (version bump, optimistic concurrency `expectedVersion`), `bulk({ids, action: 'move'|'tag'|'setStatus'|'delete', …})`, `history(key)`, `diff(key, fromVersion, toVersion)`, `yaml(key)` / `updateFromYaml(key, yaml)` (via S-029 serializer).
- `sharedSteps`: `list` (usage count), `get`, `create`, `update`.
- `requirements`: `list`, `create`, `link/unlink(caseKey, reqKey)`.
- `syncStatus(projectKey)` (S-029).

## Acceptance criteria
- [ ] Filter `tags:checkout AND priority<=P1` returns only matching cases.
- [ ] Concurrent update with stale `expectedVersion` → `CONFLICT` error.
- [ ] `diff` returns unified step-level diff between versions.
- [ ] YAML round-trip through API leaves the case unchanged.

## Tests
- Caller tests; query parser unit tests.

## Out of scope
- Running cases (S-034), generation/import (S-061/S-062).
