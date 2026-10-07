# S-046 · UI: run report & result detail

**Phase:** P3 · **Depends on:** S-035, S-045 · **Packages:** `apps/web`, `apps/server` · **Plan refs:** §2.7, §8.1 Run report, Case result detail, §8.2 flow 2
**UI:** wireframe [`docs/wireframes/07-run-report.html`](../../wireframes/07-run-report.html) · design.md §5 row 07

## Goal
Understand a finished run quickly and act on failures (rerun, defect, override, edit case).

## Scope
- Server: `runs.report(runId)` (summary, exit-criteria placeholder until S-056, results list), `results.get(resultId)` (steps, assertions, decisions, evidence refs), `results.overrideVerdict({resultId, verdict, note})` (stores override → review item for calibration).
- Route `/p/:key/runs/:runId?result=&filter=failed|review|all`; Runs list page `/p/:key/runs` (table: run, plan/cases, env, trigger, status, counts, started) linked from nav "Runs" when no live run.
- Header: breadcrumb with mono build sha, Export ▾ (JUnit · HTML · JSON via S-027/S-028 server endpoints; PDF later), **Rerun failed**.
- Summary `StatTile`s: Passed, Failed, Needs review, Flaky / Blocked, Exit criteria ("–" until S-056).
- Master list (`Segmented` Failed/Review/All; `ResultListItem`s: key, title, `env · browser · step n`, pill).
- Detail: title "KEY · Browser · failed at step N", actions Create defect (disabled until S-054), Override verdict (dialog: verdict select + note), Edit case link; `ExpectedActual`; assertion rows (deterministic summary + verdict + "deterministic"; AI check with `P(expected result is true) = 0.07` mono, model, "dual-order agreed"); `ScreenshotTimeline` (click → lightbox); evidence `Tabs`: Decisions (decision log lines + expandable `ProbabilityBar`s), Video (`<video>` range-streamed), Playwright trace (download + "open in trace viewer" instructions), Console · n, Network (table), Accessibility · n (placeholder until S-053).

## Acceptance criteria
- [ ] Deep link with `?result=` opens that result selected.
- [ ] Override verdict updates counts and creates a review record.
- [ ] Rerun failed starts a new run and navigates to it.

## Tests
- Component tests; e2e on seeded failing run.

## Out of scope
- Defect creation (S-054), exit criteria (S-056).
