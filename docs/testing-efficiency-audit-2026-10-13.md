# Testing Efficiency Audit

**Date:** 2026-10-13
**Tool:** S1-Pilot at `http://127.0.0.1:5317`
**Project:** `PLAY2`
**Configured target:** `https://playwrightlab.github.io` (`dev`)

## Verdict

S1-Pilot shows useful efficiency mechanisms, especially deterministic replay and sub-second System 1 decision latency. The available evidence does **not** yet establish that it is faster or cheaper than manual testing: no controlled manual baseline or end-to-end run duration was available, replay is only 50% of recorded steps, no healing success is recorded, and project pass rate is low. Treat efficiency as promising but unproven.

This assessment reads existing dashboard, analytics, and run data only. No new test run was launched, so it did not add run history or interact with the configured target.

## Evidence

| Signal | Observed data | What it says |
|---|---|---|
| Recent execution | Latest plan run: 10 cases, 9 passed and 1 failed | 90% passed in this run; this is a single run, not a stable suite rate. |
| Seven-day project pass rate | 59.1% | The broader current project history has substantial failures or rework. It is not an isolated measure of S1-Pilot because target behavior and test quality also affect it. |
| Execution modes, last 7 days | 50% replay, 50% explore, 0% heal | Half of the steps currently use deterministic replay; half still require model-driven exploration. No measured self-healing benefit is present. |
| Latest failed case | `PLAY2-TC-16`, “Add product and checkout”; 3 failed result rows are shown | Retry activity is visible, but attempt labels are missing, making the cost of retries hard to interpret. The reported failure was a console check for an invalid `querySelector('#')` in the target page. |
| Replay detail | The failed case’s 7 actions are marked replay | The tool did reuse learned actions for that case. Its final AI-judged assertion still called System 1 and took 725 ms. |
| System 1, last 30 days | 1,874 decisions; p50 506 ms; p95 733 ms; 3.1% escalated | Decision latency is sub-second at these percentiles, but this excludes browser execution, waits, retries, and total run time. |
| Verdict quality, last 30 days | 50% human override among 22 reviewed decisions; ECE 0.136; 0% needs review | The override rate is a caution signal from a small sample. Confidence calibration and pass/fail reliability need more reviewed outcomes. |
| Heal success | Not available (`—`) | There is no evidence yet that AI healing reduces maintenance time. |

The dashboard also showed 4 runs today and 0 currently running. The new-plan form offers a default parallel-worker count of 4, but the inspected historical run used one environment/browser combination; this does not prove that four workers were used or improved throughput.

## Efficiency Assessment

**Where it helps:** once actions have been learned, replay can avoid repeated element-selection decisions. The latest case demonstrates this reuse across all seven actions, and the app captures step screenshots, decisions, and console/network evidence that can shorten failure diagnosis.

**Where time is still spent:** half of the steps in the seven-day mode mix are Explore, and AI verdict checks can still add model latency during replay. Failures and retries also consume time; the latest failure came from a target-page selector error rather than from inability to replay the actions.

**What cannot be concluded:** the inspected run list/report did not show total wall-clock duration or a manual comparison. Model decision latency is not end-to-end test latency. The 7-day pass rate and 30-day AI metrics have different windows and should not be combined into a single efficiency score.

## Recommended Benchmark

Use a controlled, resettable test target and a non-destructive subset of cases. First run in Explore mode to establish learned scripts, then run the same unchanged cases in Replay mode under the same browser/environment. Repeat each mode at least five times and record total wall-clock duration, per-case duration, model-call time/count, attempts, and final verdict. Compare those results with a timed manual execution of the same cases. Calculate speedup only from equivalent successful runs, and report failures/retries separately.

Before using the current project for that benchmark:

- Fix the target selector error in `PLAY2-TC-16` or exclude that case until corrected.
- Fix the plan query preview mismatch so the tested case set is known to be complete.
- Restore Analytics Quality response handling and expose total run/per-case duration and retry attempt numbers in reports.
- Increase the reviewed-decision sample before drawing conclusions from override rate or calibration error.

Related functional findings are documented in [manual-ui-audit-2026-10-13.md](manual-ui-audit-2026-10-13.md).

## Recheck: 2026-10-14

The current build exposes total run duration and per-attempt duration, resolving the earlier reporting gap. The latest displayed plan run (`#MJTJ3i`) took **3m 58s** across 13 case instances: 9 passed, 1 needed review, and 3 were blocked. Retry rows now distinguish attempts. `PLAY2-TC-16` was blocked at step 7 on both attempts, taking 107.8 s and 106.7 s respectively; retries on a stuck case can therefore dominate suite time. Its console tab still flags the target page’s invalid `querySelector('#')` as a warning, but explicitly says the verdict is unchanged. The case was blocked while filling its UPI ID, so that warning is not the blocker.

Current dashboard/analytics evidence:

- Dashboard pass rate over 7 days: **74.7%**; 5 runs today; 13 cases in the project.
- Execution mix over 7 days: **59% replay, 41% explore, 0% heal**.
- System 1 decision latency: **499 ms p50 / 714 ms p95**; escalation 1.9%.
- Verdict quality: **53.1% human override** among 49 reviewed decisions; ECE 0.209; 0.4% needs review; heal success remains unavailable.

The run-duration gap is resolved, and the plan-query mismatch and Quality analytics failures are fixed. Efficiency is still **unproven versus manual testing**: there is no matched manual baseline or controlled Explore-versus-Replay comparison, the latest run includes three blocked cases, and no healing benefit has been recorded. The recommended repeated, resettable benchmark remains necessary before claiming a speedup or cost reduction.