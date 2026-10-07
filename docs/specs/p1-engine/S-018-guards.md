# S-018 · Guards

**Phase:** P1 · **Depends on:** S-015 · **Packages:** `@s1pilot/engine` · **Plan refs:** §7 Guards, §13

## Goal
Safety rails around execution: domains, read-only, sensitive actions, loops, budgets, prompt-injection hygiene.

## Scope
- `src/guards/domain.ts`: Playwright route interception blocking navigation/requests (document + xhr/fetch top-level navigations) to hosts outside `allowDomains` (+ baseUrl host); records `guard.blocked` events.
- `src/guards/read-only.ts`: when environment `readOnly`, block form submissions and non-GET same-origin requests (route abort) except allow-listed patterns.
- `src/guards/sensitive.ts`: `classifySensitive(element, action, obs) → SensitiveAction | null` for `pay|delete|send|submit-order|account-change` via keyword lists on name/text/landmark (multilingual-ready list file) + step `guard` assertions (e.g. "block submit_payment"); executor asks gate before acting.
- `src/guards/loop.ts`: same fingerprint + same action ×3 → `stuck`; max steps per case step (default 15) and per case (default 100); wall-clock budget per case (default 5 min).
- `src/guards/untrusted.ts`: wrap page-derived text in model prompts with explicit data delimiters; strip control characters; cap lengths.

## Acceptance criteria
- [ ] Navigating to a non-allowed domain on the fixture site is blocked and reported.
- [ ] On a read-only environment, the settings "Save" POST is blocked.
- [ ] "Delete account" button is classified `delete`; "Place order"/"Pay" classified `pay`.
- [ ] Loop detector fires on the 3rd identical state+action.

## Tests
- Fixture-site tests per guard; unit tests for classifier word lists.

## Out of scope
- Approval UI (S-037).
