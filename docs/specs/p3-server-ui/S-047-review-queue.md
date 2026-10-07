# S-047 · Review queue (API + UI)

**Phase:** P3 · **Depends on:** S-025, S-046 · **Packages:** `apps/server`, `apps/web` · **Plan refs:** §2.4, §2.5, §8.1 Review queue, §8.2 flow 2
**UI:** wireframe [`docs/wireframes/08-review-queue.html`](../../wireframes/08-review-queue.html) · design.md §5 row 08

## Goal
One queue for uncertain AI verdicts and heal proposals (plus placeholders for generated drafts and visual changes); every decision is stored for calibration.

## Scope
- Server `reviews` router: `counts(projectKey)` (per tab), `list({tab, page})`, `get(id)`, `decide({id, decision: 'approve'|'approve-case-only'|'reject', note, verdict? })`.
  - Uncertain verdicts: items from `needs-review` results — approve-as-passed / mark-failed; updates CaseResult verdict + stores `ReviewOutcome { pTrue, humanVerdict, questionType, optionCount, model }` for calibration.
  - Heal proposals (S-025): approve for all impacted / this case only / reject & create defect (defect link disabled until S-054 → just reject).
  - Tabs Generated drafts (S-061) and Visual changes (later) show EmptyState until implemented.
- Nav badge count via `/ws/workspace`.
- Page `/p/:key/review?tab=&item=`: header + explainer, `Tabs` with counts, list + detail.
  - Heal detail: title, found-in line, Before/After columns (eyebrow, rendered label chip, `DiffLine` locators), facts row (S1 confidence mono, S2 agreed / approved live by, Impact `N cases via shared step · all environments`, warning box "Is this a bug?" copy), Note textarea, buttons **Approve for all N cases** / Approve for this case only / Reject & create defect.
  - Verdict detail: expected text, screenshot after step, AI P(true) `ProbabilityBar` vs thresholds, assertion list, buttons Mark passed / Mark failed.
- After decision, auto-advance to next item.

## Acceptance criteria
- [ ] Approving a heal for all cases updates their learned scripts (verified via API).
- [ ] Deciding a verdict changes the run's counts and records a `ReviewOutcome`.
- [ ] Counts in tabs and nav update live.

## Tests
- API + component + e2e.

## Out of scope
- Calibration math (S-058).
