# `decide` adapter — wire format

Adapter for `POST {baseUrl}/v1/decide` (JEV family, e.g. `JEV-27B-VL`, `JEV-9B`). The endpoint answers
**one question per call**; the adapter sends the questions of one decision in parallel (at most 4 in flight).

> **Status:** this describes the format the adapter *expects*, derived from plan §5. It has been
> exercised only against local fixtures, not a live server. When a real server disagrees, fix the adapter
> and this document together (the provider probe, S-011, is where that should surface).

## Request

```http
POST /v1/decide
content-type: application/json
authorization: Bearer <apiKey>        # only when an API key is configured
```

```json
{
  "model": "jev-9b",
  "state": { "url": "https://shop.example/cart", "elements": ["…"] },
  "images": [{ "media_type": "image/png", "data": "<base64>" }],
  "question": { "kind": "choice", "instructions": "Which element completes the step?",
                "options": [{ "id": "e1", "text": "button \"Checkout\"" }, { "id": "e2", "text": "link \"Home\"" }] }
}
```

| Domain question | `question` on the wire |
|---|---|
| `choice` with `criteria: { id: description }` | `{ "kind": "choice", "instructions", "options": [{ "id", "text" }] }` (up to the profile's `maxOptions`, 256 for JEV) |
| `noul` | `{ "kind": "boolean", "instructions" }` |
| `score` with `criteria: string[]` | `{ "kind": "scale", "instructions", "levels": ["low", "mid", "high"] }` |

`images` is sent only when the profile says `supportsImages` (`JEV-27B-VL`) and images were provided.
`state` is untrusted page data, serialised as JSON data.

## Response

A single answer object (no wrapper, no question id):

```json
{ "choice": "e1", "probabilities": { "e1": 0.91, "e2": 0.09 } }
```

```json
{ "noul": 0.12 }
```

```json
{ "score": 2, "probabilities": { "low": 0.05, "mid": 0.15, "high": 0.8 } }
```

Same rules as the `systemone` answers: probabilities are re-normalised to sum to 1, `confidence = max(p)`,
`noul` is P(true) (or `probabilities: { "true", "false" }`), unknown fields are ignored.

## Errors

| Situation | code | Retried? |
|---|---|---|
| Connection failure | `MODEL_NETWORK` | once, per question |
| HTTP 5xx | `MODEL_HTTP` (`details.status`) | once, per question |
| HTTP 4xx | `MODEL_HTTP` | no |
| Timeout | `MODEL_TIMEOUT` | no |
| Invalid JSON / shape / answer | `MODEL_BAD_RESPONSE` (`details.snippet`, redacted, ≤ 500 chars) | no |

If any question still fails after its retry, the whole `decide()` rejects with that error, and
`details.questionId` names the failing question (`details.retried` is `true`, so the generic wrapper does not retry again).
