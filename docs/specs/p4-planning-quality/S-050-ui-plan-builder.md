# S-050 · UI: test plan builder

**Phase:** P4 · **Depends on:** S-049 · **Packages:** `apps/web` · **Plan refs:** §8.1 Test plan builder
**UI:** wireframe [`docs/wireframes/05-plan-builder.html`](../../wireframes/05-plan-builder.html) · design.md §5 row 05

## Goal
Create and edit plans visually and run them.

## Scope
- Routes `/p/:key/plans` (list: name, release, cases, matrix, schedule, last run status) and `/p/:key/plans/:planId` (`new` for create).
- Header: breadcrumb `SHOP · Test plans / Edit`, editable h1 (release + name), Save plan (secondary), **Run plan now** (saves, creates run, opens live view).
- "1 · Which cases": `Segmented` Saved query / Pick manually; query mode `QueryInput` with live `plans.preview` chips (`n cases match`, `n learned · replay`, `n not learned · explore (slower)`, `n quarantined · excluded`); manual mode: case picker dialog reusing S-043 table with checkboxes.
- "2 · Where to run": `MatrixTable` (environments × Chromium/Firefox/WebKit/Mobile (device select)); read-only env row labelled and restricted.
- "3 · How to run": Mode, Retries on failure (0–3), Parallel workers, Unattended escalations; checks: Accessibility scan (axe), Fail on console errors, Visual comparison (disabled "later"), Record video.
- Aside: Triggers (Schedule + cron input with human-readable preview "At 02:00, Mon–Fri", On deploy webhook (shows URL after save), From CI (link to Settings › API tokens), Notify Slack (disabled until S-065)); Exit criteria editable list (templates: % of P0 passed, ≥ n% of P1–P2 passed, no open defects ≥ severity, review queue empty) + "+ Add criterion"; Estimate card.
- "Add to plan" in S-043 selection bar now enabled (adds to manual plan).

## Acceptance criteria
- [ ] Preview chips update within 500 ms of query edits (debounced) and show syntax errors inline.
- [ ] Saving and reloading restores every field.
- [ ] Run plan now creates a run with the matrix expansion shown in Estimate.

## Tests
- Component + e2e.

## Out of scope
- Scheduler execution (S-052), exit criteria evaluation (S-056).
