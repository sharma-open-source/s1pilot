# S-022 · YAML case loader & CLI `run`

**Phase:** P1 · **Depends on:** S-019, S-020, S-021 · **Packages:** `@s1pilot/sync` (loader), `apps/cli` · **Plan refs:** §1.2, §12, §15 P1

## Goal
Run test cases written as YAML from the terminal in **explore** mode — the P1 exit milestone.

## Scope
- `@s1pilot/sync/src/load.ts`: `loadCaseFile(path) → TestCase`, `loadProjectDir(dir)` reading `.s1pilot/project.yaml` (project + environments + model settings; secrets as `env:` refs) and `suites/**.yaml`.
- `apps/cli`: `s1pilot run <file-or-dir> --env <name> [--model-url --model --adapter] [--s2-url --s2-model] [--headed] [--attended] [--browser chromium|firefox|webkit] [--out ./s1pilot-results]`.
  - Launches Playwright, creates `EngineContext`, runs steps via explore loop + verifier, prints a live line per step (`✓ 2 · Choose colour… (explore, 3 actions, 1.8 s)`), writes `trace.jsonl` + `result.json` per case into `--out`.
  - Exit code 0 when all passed, 1 failed, 2 needs-review only, 3 config error.
- Minimal `profiles` default when no model is configured: error with guidance.

## Acceptance criteria
- [ ] `s1pilot run fixtures/sites/cases/shop/tc-042.yaml --env local --adapter mock --mock-script …` passes end to end in CI.
- [ ] Same with seeded bug produces exit code 1 and a failing step in `result.json`.
- [ ] Measure & print step success rate across fixture suites (for P1 exit criterion ≥ 70% with real models — documented manual check).

## Tests
- CLI integration test spawning the binary against fixture server with mock model.

## Out of scope
- Replay/heal (S-023+), reporters (S-027).
