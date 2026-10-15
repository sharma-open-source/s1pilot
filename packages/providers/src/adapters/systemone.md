# `systemone` adapter — wire format

Adapter for `POST {baseUrl}/v1/systemone` (Clef, Laya via `laya-serve`, TypeSafe Jev).

> **Status:** tested live against Cloudflare Clef (`cloudflare/clef`) through OpenRouter's decisions endpoint
> (`https://openrouter.ai/api/alpha/decisions`) on 2026-10-08: `probe` succeeded and the shop smoke test
> (`fixtures/sites/cases/shop/tc-042.yaml`) passed 4/4, with the seeded-bug run failing at the expected step (see
> "Real-model smoke test" in `AGENTS.md`). Unit tests use recorded fixtures and the mock adapter. When a real
> server disagrees with this document, fix the adapter and this document together (the provider probe, S-011, is
> the place to detect it).

## Request

```http
POST /v1/systemone
content-type: application/json
authorization: Bearer <apiKey>        # only when an API key is configured
```

```json
{
  "model": "clef-flash",
  "state": { "url": "https://shop.example/cart", "elements": [{ "id": "e1", "role": "button", "name": "Checkout" }] },
  "images": [{ "media_type": "image/png", "data": "<base64>" }],
  "questions": {
    "next_action": { "type": "choice", "instructions": "Which element completes the step?", "criteria": { "e1": "button \"Checkout\"", "e2": "link \"Home\"" } },
    "step_done":   { "type": "noul",   "instructions": "Has this test step's action been fully performed?" },
    "quality":     { "type": "score",  "instructions": "How complete is the page?", "criteria": ["low", "medium", "high"] }
  }
}
```

- `images` is sent only when the model's capabilities say `supportsImages`, and only if images were provided.
- All questions of one decision go in **one** call (`multiQuestionPerCall`); a profile that says otherwise makes the adapter send one question per call, at most 4 in parallel.
- `state` is untrusted page data. It is serialised as JSON data and never concatenated into instructions.

## Response

```json
{
  "answers": {
    "next_action": { "choice": "e1", "probabilities": { "e1": 0.9231, "e2": 0.0769 } },
    "step_done":   { "noul": 0.12 },
    "quality":     { "score": 2, "probabilities": { "low": 0.05, "medium": 0.15, "high": 0.8 } }
  }
}
```

- The `answers` wrapper is optional: a bare `{ "<question id>": { … } }` object is accepted too.
- Per answer, all fields are optional, but there must be enough to answer the question type:
  - `choice`: `probabilities` over the option ids (`choice` defaults to the most probable one).
  - `noul`: `noul` = P(true), or `probabilities: { "true": …, "false": … }`.
  - `score`: `probabilities` over the criteria levels, or a bare `score` index.
- Probabilities are re-normalised to sum to 1; `confidence = max(p)` (for `noul`: `max(P, 1 − P)`).
- Unknown extra fields are ignored.

## Errors

| Situation | `S1PilotError` code | Retried once? |
|---|---|---|
| Connection refused / DNS / reset | `MODEL_NETWORK` | yes |
| HTTP 5xx | `MODEL_HTTP` (`details.status`) | yes |
| HTTP 4xx (e.g. 401) | `MODEL_HTTP` (`details.status`) | no |
| Request exceeds the timeout | `MODEL_TIMEOUT` | no |
| Invalid JSON, wrong shape, missing/invalid answer | `MODEL_BAD_RESPONSE` | no |

`MODEL_HTTP` and `MODEL_BAD_RESPONSE` carry `details.snippet`: the first 500 characters of the body, with
the API key and sensitive-looking values redacted.
