# S-029 · Tests-as-code sync

**Phase:** P2 · **Depends on:** S-003, S-026 · **Packages:** `@s1pilot/sync` · **Plan refs:** §1.2

## Goal
Two-way sync between the DB (source of truth) and a git-friendly `.s1pilot/` folder.

## Scope
- Layout: `.s1pilot/project.yaml`, `environments/<name>.yaml` (no secret values; `secret: true` + `env:` ref), `suites/<suite-path>/<key-lower>-<slug>.yaml`, `flows/*.yaml`, `data/*`, `plans/*.yaml`.
- `exportProject(db, projectId, dir)` — deterministic output (stable key order, sorted lists) so diffs are minimal.
- `importProject(db, dir, { dryRun }) → SyncPlan { creates, updates, conflicts, deletes }`; conflict when file `version` < DB version and contents differ → returned with a unified diff; never auto-overwrite newer DB versions.
- `syncStatus(db, projectId, dir) → 'clean' | { changedFiles, conflicts }` (for UI "Synced with .s1pilot/ in git · clean").
- CLI: `s1pilot sync export|import|status [--dir] [--project]`.

## Acceptance criteria
- [ ] Export → import into empty DB → export again produces byte-identical files.
- [ ] Editing a step in YAML and importing bumps the case version.
- [ ] Concurrent change (DB v4, file based on v3) is reported as conflict with diff.

## Tests
- Round-trip and conflict tests with temp dirs.

## Out of scope
- Git commands (users commit themselves), UI diff viewer (S-044 History tab).
