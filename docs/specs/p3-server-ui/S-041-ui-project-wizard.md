# S-041 · UI: new project wizard

**Phase:** P3 · **Depends on:** S-039, S-032 · **Packages:** `apps/web` · **Plan refs:** §8.1 Create project wizard, §8.2 flow 1, §13
**UI:** wireframe [`docs/wireframes/02-project-wizard.html`](../../wireframes/02-project-wizard.html) · design.md §5 row 02

## Goal
Create a project in five steps: Basics → Environments → Models → Login setup → First tests.

## Scope
- Route `/projects/new?step=basics|environments|models|login|first-tests`; draft state kept in react-hook-form + sessionStorage until finish; project created at end of step 1 (so later steps save incrementally).
- `WizardStepper` (done ✓ / current ink / upcoming dashed).
- Steps:
  1. Basics: name, key (auto from name, uppercase, validated), base URL.
  2. Environments: list editable rows (name, base URL); defaults `dev` from base URL.
  3. **Models** (match artboard exactly): S1 card (API adapter select incl. Auto-detect, Base URL, Model, API key password), **Test connection** → `models.probe` with inline progress then result line `Connected · decision returned in N ms` (or error), `CapabilityGrid` (Detected adapter, Max options / question, Questions per call, Images, Context), Confidence policy fieldset (two ranges with mono readouts: act/pass ≥, escalate below; checkbox "Ask twice in shuffled order for sensitive actions"). Side: S2 card ("Optional" pill, base URL, model, Test connection), "Data sent to models" checkboxes; warning Callout "Cloud endpoint detected for System 2 — page data leaves this machine." when `isCloud`.
  4. Login setup: optional; buttons "Record a login" / "Use a flow" / "Skip" (uses S-038 API).
  5. First tests: textarea "Describe a test in plain language" → creates draft case + "Run now (explore)" → navigates to live run.
- Footer: Back (secondary) / Continue to <next step> (ink).

## Acceptance criteria
- [ ] Probe success and failure states render as in design.md §6.
- [ ] Threshold sliders constrain escalate < act.
- [ ] Completing all steps creates project, envs, model settings and one case; "Run now" starts a run.
- [ ] Wizard usable at 400 px.

## Tests
- Component tests per step; Playwright e2e of full wizard against fake probe server.

## Out of scope
- Crawl-based suggested tests (S-061).
