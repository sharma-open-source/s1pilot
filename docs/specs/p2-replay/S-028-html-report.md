# S-028 · HTML report (self-contained)

**Phase:** P2 · **Depends on:** S-027 · **Packages:** `@s1pilot/reporters` · **Plan refs:** §2.7
**UI:** wireframe [`docs/wireframes/07-run-report.html`](../../wireframes/07-run-report.html) · design.md §4.2, §5 (screen 07)

## Goal
A single offline `.html` file summarising a run that looks like the in-app Run report.

## Scope
- `src/html/`: render with a small template (no React runtime needed; Preact + `renderToString` acceptable) inlining CSS tokens from design.md, fonts falling back to system stacks, screenshots inlined as data URIs (cap total 15 MB, else link to files).
- Sections: summary tiles (Passed, Failed, Needs review, Flaky/Blocked), results list with status pills, per-result detail: Expected vs Actual, assertion rows, screenshot timeline, decision log (options + probabilities as bars).
- Filter buttons Failed / Review / All via tiny inline script; works without JS (all expanded).
- CLI `--reporter html`.

## Acceptance criteria
- [ ] Report opens from disk without network (verify no external URLs except optional Google Fonts link).
- [ ] Status colours and pills match design.md §2.2.
- [ ] Contains no secret values (test with seeded secret).

## Tests
- Golden snapshot of rendered HTML structure; size cap test.

## Out of scope
- PDF export (S-056), Allure (later).
