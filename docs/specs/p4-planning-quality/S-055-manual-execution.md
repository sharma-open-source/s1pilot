# S-055 · Manual / hybrid execution

**Phase:** P4 · **Depends on:** S-054 · **Packages:** `apps/server`, `apps/web` · **Plan refs:** §2.2 assignment, §2.3 Manual/hybrid, Exploratory
**UI:** wireframe [`docs/wireframes/10-manual-run.html`](../../wireframes/10-manual-run.html) · design.md §5 row 10

## Goal
Testers execute assigned cases step by step (optionally after an AI pre-run), recording verdicts, actual results and attachments.

## Scope
- Plans: per-case assignee + "manual" flag; manual cases in a run create `ManualSession` items assigned to users (local mode: the single user).
- Hybrid: when enabled, the AI pre-runs steps on a chosen browser first; steps it passed show "AI pre-run: passed · confirm?".
- Server `manual` router: `myQueue()`, `start(sessionItemId)`, `recordStep({itemId, stepIndex, verdict: pass|fail|blocked|na, actual?, attachments[]})`, `finish(itemId)`, `notes.update`, `noteToDraft(note)` (creates draft case; uses S2 to structure steps if configured, else one-step draft).
- Upload attachments → artifact store.
- Page `/p/:key/manual/:sessionId`: breadcrumb with assignment + "case x of n", h1 `KEY · Title` (24 px), meta (env · device · mono timer), actions Previous case / Skip / **Finish & next case**; `info-ai` hybrid callout; step articles (done collapsed with pill, AI-pre-run with warning "confirm?" pill + Confirm/Redo, current expanded: Pass/Fail/Blocked/N/A `Segmented` (Fail pressed = danger), Actual result textarea, attachment thumbs + "+ Attach screenshot or video", "Create defect from this step" link → S-054 prefilled), pending muted); aside My queue (pills) + Session notes + "Turn note into test case draft".
- Results appear in run report with mode `manual`.

## Acceptance criteria
- [ ] Completing all steps produces a CaseResult with verdict = worst step verdict.
- [ ] Timer persists across reloads.
- [ ] Create defect from step pre-fills steps 1..n and actual result.

## Tests
- API + component + e2e.

## Out of scope
- Exploratory session recordings (later).
