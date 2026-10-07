# S-054 · Defects (API + UI)

**Phase:** P4 · **Depends on:** S-046 · **Packages:** `apps/server`, `apps/web` · **Plan refs:** §2.6, §8.1
**UI:** wireframe [`docs/wireframes/11-defects.html`](../../wireframes/11-defects.html) · design.md §5 row 11

## Goal
Create defects in one click from failed results (or manual steps / a11y findings), track them, and link them to results; local tracker now, external sync in S-064.

## Scope
- Server `defects` router: `list({projectKey, query})` (fields: status, severity, tracker), `get`, `createFromResult({resultId, stepIndex?})` → prefilled draft (title from case + failure, steps to reproduce from executed steps' action text, expected vs actual, environment, browser, build ref, screenshot evidence links), `create`, `update`, `linkResult`, `close`.
- Severity enum `S1 Critical | S2 Major | S3 Minor | S4 Trivial`; status `draft|open|in-progress|fixed|closed`.
- "Re-test automatically when closed" flag → on status `fixed|closed`, queue linked failed case instances (same env/browser) as a new run (`trigger: 'retest'`).
- Page `/p/:key/defects`: eyebrow tracker sync line (or "Local defects"), header Filter `QueryInput` + **New defect**; table (ID mono, Title + source line, Severity tag, Failing results, Tracker (link ↗ / "Not pushed"), Status); selected row highlight; aside "New defect" form (title, severity, auto steps-to-reproduce inset, `ExpectedActual`, attachments line with mono build sha, "Push to <tracker>" checkbox (disabled until S-064), "Re-test automatically when closed", **Create defect**).
- Enable "Create defect" in Run report (S-046) and "Reject & create defect" in Review queue (S-047) → opens page with prefilled aside.

## Acceptance criteria
- [ ] Create from failed result pre-fills all fields per artboard.
- [ ] Closing a defect with re-test on queues the linked cases.
- [ ] Defect list filter `status:open` works (shared query module).

## Tests
- API + component + e2e.

## Out of scope
- Jira/GitHub sync (S-064).
