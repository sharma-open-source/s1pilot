# S-007 · `systemone` adapter

**Phase:** P1 · **Depends on:** S-006 · **Packages:** `@s1pilot/providers` · **Plan refs:** §4.7, §5

## Goal
Talk to `POST {baseUrl}/v1/systemone` (Clef, Laya via `laya-serve`, TypeSafe Jev) through the `DecisionModel` contract.

## Scope
- `src/adapters/systemone.ts`: build request body `{ model, state, images?, questions }` where questions map 1:1 to plan §5 `Question` (`noul` / `choice` with `criteria` / `score` with `criteria[]`); parse response into `DecideAnswer` per question (choice + probabilities, score + distribution, noul probability).
- Images: base64 data with mime; only sent when `capabilities.supportsImages`.
- Auth header `Authorization: Bearer <apiKey>` when configured.
- Map HTTP/schema errors to `S1PilotError` codes `MODEL_HTTP`, `MODEL_BAD_RESPONSE`.
- Response schema validated with zod; unknown extra fields ignored.
- Document the expected wire format in `src/adapters/systemone.md` (request/response examples).

## Acceptance criteria
- [ ] Given a recorded response fixture, a 3-question request returns `{next_action, step_done, blocked}` answers with probabilities summing to 1 (±1e-6).
- [ ] Multi-question requests are sent in a single call.
- [ ] Bad JSON / missing fields → `MODEL_BAD_RESPONSE` with the raw snippet (truncated 500 chars, redacted).

## Tests
- MockAgent/msw fixtures: success, 401, 500 (retried once), malformed.

## Out of scope
- Detection of which adapter a server speaks (S-011).
