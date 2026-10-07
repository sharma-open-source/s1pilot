# S-009 · `openai-logprobs` adapter

**Phase:** P1 · **Depends on:** S-006 · **Packages:** `@s1pilot/providers` · **Plan refs:** §4.7, §5

## Goal
Use a plain vLLM `/v1/chat/completions` server as a decision model by reading next-token log-probabilities over option tokens.

## Scope
- `src/adapters/openai-logprobs.ts`:
  - Prompt template per question type: state + instructions + enumerated options labelled with single-token labels (`A`…`Z`, then `0`…`9`, configurable); answer "with the label only".
  - Request: `max_tokens: 1`, `logprobs: true`, `top_logprobs: 20`, `temperature: 0`, `top_p: 1`, `top_k: 0` and `allowed_token_ids` when a tokenizer map is configured (`profile.tokenIds`), else rely on top_logprobs.
  - Convert logprobs over label tokens → softmax-normalised probabilities; `noul` uses labels `yes/no`; `score` uses digit labels.
  - Options beyond label alphabet → throw `MODEL_TOO_MANY_OPTIONS` (narrowing upstream must handle).
- Declare `orderSensitive: true` by default.

## Acceptance criteria
- [ ] Fixture response with top_logprobs for `A,B,C` yields normalised probabilities matching expected values.
- [ ] Missing label tokens in top_logprobs get probability 0 and a `details.missingLabels` warning (not an error) unless all are missing → `MODEL_BAD_RESPONSE`.
- [ ] One HTTP call per question (fan-out).

## Tests
- Unit tests for prompt rendering (snapshot), label mapping, logprob → probability math.

## Out of scope
- Calibration temperatures (S-058).
