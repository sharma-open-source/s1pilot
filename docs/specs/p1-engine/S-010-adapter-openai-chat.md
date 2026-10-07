# S-010 · `openai-chat` System 2 adapter

**Phase:** P1 · **Depends on:** S-006 · **Packages:** `@s1pilot/providers` · **Plan refs:** §5 (System 2), §7

## Goal
A `ChatModel` implementation for any OpenAI-compatible chat endpoint, used for second opinions, step text, free-text inputs and generation.

## Scope
- `src/adapters/openai-chat.ts`: `chat()` (plain / JSON mode with zod-validated parse and one repair retry), `pickOption()` (constrained to option ids: prompt lists ids, asks for JSON `{choice, rationale}`, rejects ids not in the set → retry once → `MODEL_BAD_RESPONSE`).
- `isCloudEndpoint(url)` helper: false for localhost, 127.0.0.0/8, ::1, RFC1918, `*.local`; true otherwise (used by UI warning in S-041 and data policy).
- All prompts pass through the `Redactor` (S-004) supplied by the caller.

## Acceptance criteria
- [ ] `pickOption` never returns an id outside the provided options.
- [ ] JSON mode returns typed object or throws after one repair attempt.
- [ ] `isCloudEndpoint` table test passes for 10+ hosts.

## Tests
- HTTP fixtures for success, invalid choice then valid, invalid twice.

## Out of scope
- Test generation prompts (S-061), recorder step text (S-060).
