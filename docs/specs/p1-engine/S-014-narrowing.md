# S-014 · Coarse-to-fine narrowing

**Phase:** P1 · **Depends on:** S-006, S-013 · **Packages:** `@s1pilot/engine` · **Plan refs:** §4.3, §6 (`narrow`), §16

## Goal
Keep every `choice` question within the model's `maxOptions` by first choosing a region, then an element.

## Scope
- `src/decide/narrow.ts`: `narrow(obs, caps, model, stepText) → { candidates: ObservedElement[]; trail: DecisionRecord[] }`.
  - Reserve slots for meta actions (`scroll_down`, `scroll_up`, `go_back`, `step_done`, `stuck`).
  - If elements + meta ≤ `maxOptions` → return all.
  - Else group by landmark (fallback: vertical bands of the viewport); ask `choice` "Which region most likely contains the control for: <step>?" (options = region names with element counts + sample labels); recurse inside chosen region; if a region still too large split into chunks.
  - Keep top-2 regions when confidence of top region < 0.6 (merge if fits).
- Cheap pre-filter: lexical overlap score between step text and element name/text to order options (models are order-sensitive; most relevant first).

## Acceptance criteria
- [ ] With `maxOptions: 20` and a 120-element page, every model call has ≤ 20 options.
- [ ] With the mock model choosing correct regions, the target element is in final candidates for all shop steps.
- [ ] Trail decisions are returned for trace recording.

## Tests
- Unit tests with synthetic observations; fixture test with a generated 150-link page.

## Out of scope
- Final action choice (S-019).
