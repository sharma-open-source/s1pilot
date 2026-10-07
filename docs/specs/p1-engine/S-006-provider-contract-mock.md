# S-006 · Provider contract, mock adapter & capability profiles

**Phase:** P1 · **Depends on:** S-002 · **Packages:** `@s1pilot/providers`, `profiles/` · **Plan refs:** §4, §5

## Goal
A single `DecisionModel` interface, a registry/factory, a deterministic mock adapter for tests and demos, and capability profiles for the reference models.

## Scope
- `src/contract.ts`: re-export `DecisionModel`, `Question`, `DecideRequest`, `DecideAnswer`, `Capabilities` from domain; add `ChatModel` (System 2) interface:
  ```ts
  interface ChatModel { chat(req:{ system?:string; messages:{role:'user'|'assistant';content:string}[]; json?: boolean; maxTokens?: number }): Promise<{ text: string; latencyMs: number }>;
                         pickOption(req:{ context:string; question:string; options: Record<string,string> }): Promise<{ choice: string; rationale?: string }> }
  ```
- `src/registry.ts`: `createDecisionModel(endpoint: ModelEndpoint, opts) → DecisionModel`, `createChatModel(endpoint) → ChatModel`; adapters register by name.
- `src/util/normalize.ts`: normalise probabilities to sum 1, compute `confidence = max(p)`; `noul` answer → `{ noul: P(true), probabilities: {true, false} }`.
- `src/util/fanout.ts`: when `capabilities.multiQuestionPerCall=false`, split questions and call in parallel (concurrency limit 4).
- `src/adapters/mock.ts`: `MockDecisionModel` driven by a script: `{ match: (q, state) => boolean, answer }[]` plus fallback strategies `first`, `random(seed)`, `byLabelIncludes(text)`. Records every call for assertions.
- `profiles/*.json` + loader `loadProfile(id)`: `clef`, `clef-flash`, `jev`, `jev-9b`, `laya` with `Capabilities` (`maxOptions` — JEV 256, Laya 20, Clef/flash 64 placeholder), default thresholds, `orderSensitive`, recommended adapter.
- Timeouts & retries wrapper (`withTimeout(ms)`, 1 retry on 5xx/network) applied to all adapters.

## Interfaces
`createDecisionModel`, `createChatModel`, `MockDecisionModel`, `loadProfile`, `normalizeAnswer`.

## Acceptance criteria
- [ ] A test can script MockDecisionModel to choose `e3` for a `choice` question and receive probabilities + confidence.
- [ ] Fan-out merges per-question answers into one record keyed by question id.
- [ ] Profiles validate against `CapabilitiesSchema`.
- [ ] Timeout raises `S1PilotError('MODEL_TIMEOUT')`.

## Tests
- Unit tests for normalise, fan-out, mock scripting, profile loading.

## Out of scope
- Real HTTP adapters (S-007–S-010), probe (S-011).
