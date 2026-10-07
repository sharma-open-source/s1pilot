# S-023 · Learned script capture

**Phase:** P2 · **Depends on:** S-022 · **Packages:** `@s1pilot/engine`, `@s1pilot/sync` · **Plan refs:** §6 Learned script output, §1.1 LearnedScript

## Goal
Every successful explore run produces a `LearnedScript` (per case version × environment) that can be replayed without the model.

## Scope
- `src/learned/recorder.ts`: hooks into explore loop; for each executed action store `ResolvedAction { stepIndex, subIndex, kind, locators (all candidates, winning first), valueRef?, preFingerprint, postFingerprint, waitHint }`.
- Only persisted when the case verdict is `passed` (or human-approved) — `buildLearnedScript(run) → LearnedScript | null`.
- Storage in CLI mode: `.s1pilot/learned/<caseKey>/<env>.json`; in server mode via repo (S-003) — `LearnedScriptStore` interface with FS and DB implementations.
- Invalidate when case version changes steps (step text hash per step; untouched steps keep their actions).

## Acceptance criteria
- [ ] Explore run of TC-42 writes a learned script with 4 steps and ≥ 1 action each.
- [ ] Editing step 3 text invalidates only step 3's actions.
- [ ] No secret values; only `valueRef`s.

## Tests
- Unit + fixture integration.

## Out of scope
- Using the script (S-024).
