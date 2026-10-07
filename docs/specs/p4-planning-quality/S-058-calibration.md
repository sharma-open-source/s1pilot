# S-058 · Calibration

**Phase:** P4 · **Depends on:** S-047 · **Packages:** `@s1pilot/engine`, `apps/server`, `apps/cli` · **Plan refs:** §2.4 thresholds validated, §4.5, §14 Calibration

## Goal
Use human review outcomes to correct over/under-confident model probabilities and validate thresholds per project.

## Scope
- Data: `ReviewOutcome`s (S-047), live approvals (S-037), overrides (S-046).
- Temperature scaling per `(model, questionType, optionCountBucket)`: fit T by minimising NLL (golden-section search); store `CalibrationModel { key, T, n, eceBefore, eceAfter, fittedAt }`; require n ≥ 50 per bucket else fall back to coarser bucket or T=1.
- Apply in providers' `normalizeAnswer` via injected calibrator (probabilities^(1/T) renormalised).
- ECE computation (10 bins) + reliability diagram data for Analytics.
- Threshold suggestion: pick pass/fail thresholds hitting target false-pass ≤ 1% on reviewed data; shown as suggestion, applied only on user confirm.
- API `calibration.fit(projectKey)`, `calibration.status`; CLI `s1pilot calibrate --project SHOP`.

## Acceptance criteria
- [ ] Synthetic over-confident data (true acc 70% at p=0.9) → fitted T > 1 and ECE reduced.
- [ ] Calibrated probabilities used in subsequent gating (verified via decision records storing raw + calibrated).
- [ ] Suggest thresholds never auto-applied.

## Tests
- Unit tests on synthetic datasets.

## Out of scope
- Fine-tuning export (later).
