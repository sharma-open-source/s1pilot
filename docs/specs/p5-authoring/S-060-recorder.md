# S-060 · Recorder

**Phase:** P5 · **Depends on:** S-023, S-044 · **Packages:** `@s1pilot/runner`, `apps/server`, `apps/web` · **Plan refs:** §2.1 Record mode

## Goal
User clicks through the app in a headed browser; s1pilot captures actions into natural-language steps and a learned script at the same time.

## Scope
- `recorder.start({ projectKey, environment, caseKey?, fromStep? })` opens headed Chromium (local mode) with an injected recording script (capture click/fill/select/check/press/navigation with element descriptors from S-012 logic in page) + small floating toolbar (Stop, Add expected result, Pause).
- Grouping: consecutive actions grouped into steps by navigation / pause > 4 s / explicit "Add expected result".
- Step text: System 2 writes action + expected text from grouped descriptors (S-010 JSON mode); without S2, template text ("Click 'Checkout as guest'", "Fill 'ZIP' with shipping_zip").
- Typed values: matched to existing variables/params (exact match → `var:` ref); others → new variable proposal (never store passwords: password fields become `secret:<new key>` prompts).
- Output: steps appended to case (or new draft case) + learned script for that environment.
- UI: enable "Record in browser" (S-043) and "Record steps from here" (S-044); recording panel shows live captured steps; Stop → review dialog to edit text before saving.

## Acceptance criteria
- [ ] Recording the shop guest checkout produces ~4 steps and a replayable learned script (replay passes).
- [ ] Password typed during recording is never persisted in plaintext.
- [ ] Works without S2 (template text).

## Tests
- Integration test driving the headed browser via Playwright in headless mode with recorder injected.

## Out of scope
- Recording in Firefox/WebKit.
