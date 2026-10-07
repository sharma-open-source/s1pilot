# S-056 · Exit criteria & release readiness

**Phase:** P4 · **Depends on:** S-051, S-054 · **Packages:** `apps/server`, `@s1pilot/reporters`, `apps/web` · **Plan refs:** §2.2 entry/exit criteria, §2.7, §8.2 flow 3

## Goal
Evaluate plan exit criteria per run, show them in the report, and produce a sign-off export.

## Scope
- `ExitCriterion` types: `passRate {priority[], minPct}`, `noOpenDefects {minSeverity}`, `reviewQueueEmpty`, `noFlaky {priority[]}`, `allExecuted`.
- `evaluateExitCriteria(run, plan, db) → { met: boolean, items: { criterion, met, actual, detail }[] }` computed on run finish and on relevant changes (review decided, defect closed).
- Run report tile "Exit criteria · x of n not met" + popover list; Analytics "Release readiness" data (S-057).
- CLI exit code: non-zero when criteria unmet (used in S-063).
- PDF summary export: render HTML report (S-028) summary section + criteria to PDF via Playwright `page.pdf()`; endpoint `GET /api/runs/:id/export.pdf`.
- "Sign off" action (QA lead in team mode; local user now): records sign-off with note on the run.

## Acceptance criteria
- [ ] Criteria re-evaluate when a review item is approved.
- [ ] PDF export opens and includes criteria table.
- [ ] Wireframe "2 of 4 not met" state reproducible with seed data.

## Tests
- Unit tests per criterion; API test for PDF content-type/size.

## Out of scope
- Analytics charts (S-057).
