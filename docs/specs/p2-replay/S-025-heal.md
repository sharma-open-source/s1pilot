# S-025 · Heal mode & heal proposals

**Phase:** P2 · **Depends on:** S-024 · **Packages:** `@s1pilot/engine`, `@s1pilot/db` · **Plan refs:** §2.3 Heal, §2.5, §8.1 Review queue

## Goal
When replay breaks, System 1 re-resolves only the broken step; the fix is saved as a **heal proposal** for review rather than silently overwriting.

## Scope
- `src/loop/heal.ts`: on `ReplayBreak`, run `exploreStep` for that step only (starting from current page state), then continue replay with the next step.
- `HealProposal { id, caseId, stepIndex, environmentId, runId, before: ResolvedAction[], after: ResolvedAction[], confidence, s2Agreed?, approvedLive?: userId, sharedStepId?, impactCaseIds[], status: 'pending'|'approved'|'rejected' }`.
- Policy: confidence ≥ act → step marked `healed`, run continues using the healed actions; proposal created as `pending` (auto-applied to learned script only if project setting `autoApplyHeals=true`).
- Impact: if the step comes from a shared step, compute all cases using it (`impactCaseIds`).
- Repo functions: `healProposals.create/list/approve(scope:'all'|'case')/reject`. Approve updates learned scripts (all impacted or one case).

## Acceptance criteria
- [ ] With variant `shop.guest-button-renamed` + mock S1 choosing the new button, run passes with step 3 `healed` and one pending proposal containing before/after locators `getByRole('button',{name:'Guest checkout'})` → `…'Checkout as guest'`.
- [ ] Approving with scope `all` updates every impacted case's learned script.
- [ ] Rejecting leaves scripts unchanged.

## Tests
- Fixture integration + repo tests.

## Out of scope
- Review UI (S-047).
