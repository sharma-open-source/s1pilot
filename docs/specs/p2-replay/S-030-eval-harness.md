# S-030 · Eval harness & seeded-bug metrics

**Phase:** P2 · **Depends on:** S-027 · **Packages:** `apps/cli`, `suites/` · **Plan refs:** §14, §15 P1/P2 exit criteria

## Goal
`s1pilot eval` measures engine quality against fixture ground truth so model/engine changes are comparable.

## Scope
- `suites/<name>/suite.yaml`: fixture site, cases, bug sets, variants, expected verdicts (from S-005 ground truth).
- `s1pilot eval --suite fixtures-all --model-url … [--models clef-flash,jev-9b] --repeat 3 --out eval-results/`:
  - for each model × bug set × case: run (explore and replay), compare verdicts.
  - metrics: step success, bug detection rate, false-fail, **false-pass**, needs-review rate, heal success, replay hit rate, decision latency p50/p95, escalations.
- Output `eval-results/<timestamp>/summary.json` + markdown leaderboard table.
- Mock-model "oracle" mode for CI (checks harness wiring, not model quality).

## Acceptance criteria
- [ ] Oracle mode in CI yields 100% detection, 0 false-pass.
- [ ] Leaderboard markdown lists all metrics per model.
- [ ] Each eval result records model id, profile, engine git sha.

## Tests
- Harness unit tests; CI run in oracle mode.

## Out of scope
- Calibration fitting (S-058).
