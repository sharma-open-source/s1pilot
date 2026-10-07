# S-008 · `decide` adapter

**Phase:** P1 · **Depends on:** S-006 · **Packages:** `@s1pilot/providers` · **Plan refs:** §4.7, §5

## Goal
Support the JEV family endpoint `POST {baseUrl}/v1/decide` (one question per call).

## Scope
- `src/adapters/decide.ts`: one HTTP call per question, fanned out via `fanout.ts`; translate `Question` → JEV request (options list / boolean / scale), parse probabilities.
- Declares `multiQuestionPerCall: false`.
- Image support per profile (`JEV-27B-VL`).
- Wire format doc `src/adapters/decide.md`.

## Acceptance criteria
- [ ] 3 questions → 3 parallel HTTP calls → merged answer record.
- [ ] Partial failure (one call 500 after retry) rejects the whole `decide()` with `MODEL_HTTP` and question id in `details`.
- [ ] 256-option choice request is accepted (no artificial cap below profile `maxOptions`).

## Tests
- HTTP fixtures; concurrency test asserting ≤ 4 in-flight requests.

## Out of scope
- Narrowing large option sets (S-014).
