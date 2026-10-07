# S-012 · Observer: interactive elements & locators

**Phase:** P1 · **Depends on:** S-002, S-005 · **Packages:** `@s1pilot/engine` · **Plan refs:** §4.4, §6 Observer

## Goal
Turn a Playwright `Page` into a stable, text-first list of interactive elements with short ids and robust locators.

## Scope
- `src/observer/elements.ts`: `captureElements(page) → ObservedElement[]`.
  - Sources: `page.accessibility.snapshot({ interestingOnly: true })` + DOM query for interactive tags/roles (`a[href]`, `button`, `input`, `select`, `textarea`, `[role=button|link|tab|menuitem|checkbox|radio|combobox|option|switch]`, `[contenteditable]`, `[onclick]` heuristically) incl. open shadow roots and same-origin iframes.
  - Filter: visible (non-zero box, not `visibility:hidden`, in viewport or scrollable into view), enabled.
  - Descriptor: `{ id: 'e1'…, role, name, text (trimmed 120 chars), placeholder?, value? (masked if password/secret), checked?, selected?, expanded?, landmark (nearest region/nav/main/form/dialog name), box: {x,y,w,h}, frame? }`.
  - Ids assigned in document order; stable within one capture.
- `src/observer/locators.ts`: per element, ordered `LocatorCandidate[]`: `getByRole(role,{name,exact})` → `getByTestId` (data-testid/data-test/data-qa) → `getByText` (unique only) → CSS path (fallback). `toPlaywrightLocator(page, candidate)`; `resolveFirstUnique(page, candidates)`.
- Element map kept on `Observation` for executor lookup.

## Interfaces
```ts
interface ObservedElement { id: string; role: string; name: string; text?: string; placeholder?: string; value?: string; state: {checked?:boolean; selected?:boolean; expanded?:boolean; disabled?:false}; landmark?: string; box: Box; locators: LocatorCandidate[] }
```

## Acceptance criteria
- [ ] On `/shop` cart page the "Guest checkout" button is found with role `button`, correct name and a role locator that resolves uniquely.
- [ ] Password field values are never present in descriptors.
- [ ] Hidden/disabled elements are excluded; elements inside an open dialog are tagged `landmark: dialog:<name>`.
- [ ] Capture of a 200-element page completes in < 500 ms (headless Chromium, CI machine).

## Tests
- Fixture-site tests on each site; snapshot of descriptor list (ids, roles, names).

## Out of scope
- Page context & screenshots (S-013), narrowing (S-014).
