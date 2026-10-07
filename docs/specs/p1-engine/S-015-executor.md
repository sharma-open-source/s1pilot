# S-015 · Executor

**Phase:** P1 · **Depends on:** S-012 · **Packages:** `@s1pilot/engine` · **Plan refs:** §6 Executor

## Goal
Perform a chosen action on an element reliably and report what happened.

## Scope
- `src/executor/index.ts`: `execute(page, action: EngineAction, ctx) → ActionOutcome`.
  - `EngineAction` union: `click`, `fill {valueRef}`, `selectOption {label|valueRef}`, `check`, `uncheck`, `press {key}`, `hover`, `scroll {dir}`, `goBack`, `goto {url}`, `upload {fileRef}`.
  - Role-based inference `inferAction(element, hasValue)`: textbox/searchbox/combobox-with-text → fill; listbox/select → selectOption; checkbox/radio/switch → check; else click.
  - Locator resolution through candidates with fallback order; record which candidate succeeded.
  - Stable waits: `waitForLoadState('domcontentloaded')` + network idle (≤ 2 s) + DOM quiet (MutationObserver no changes for 300 ms, cap 3 s).
  - Popups/new tabs (switch context, record), dialogs (`alert/confirm` auto-accept unless guarded), downloads (save to temp, record path).
  - Retry once with next locator candidate on `TimeoutError`/detached.
- `ActionOutcome = { ok, usedLocator, navigated, newPage?, dialog?, download?, error?, durationMs }`.
- Values are passed as resolved strings only at the last moment; never kept in outcome (outcome has `valueRef`).

## Acceptance criteria
- [ ] All fixture-site manual flows (S-005) can be executed via `execute()` calls with locator candidates from S-012.
- [ ] Popup opening in new tab is followed and reported.
- [ ] A fill with a secret ref never stores the secret in `ActionOutcome`.

## Tests
- Fixture-site tests per action type; retry-with-fallback test using a broken first candidate.

## Out of scope
- Deciding what to do (S-019), guards (S-018).
