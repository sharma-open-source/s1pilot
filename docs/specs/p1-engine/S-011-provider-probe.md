# S-011 · Provider probe & auto-detect

**Phase:** P1 · **Depends on:** S-007, S-008, S-009, S-010 · **Packages:** `@s1pilot/providers`, `apps/cli` · **Plan refs:** §5 (Test connection / Probe), §8.1 Model settings

## Goal
Given a base URL (+ optional model, key), detect which adapter it speaks, its capabilities and latency; expose as library + `s1pilot probe`.

## Scope
- `src/probe.ts`: `probe(endpoint: { baseUrl; model?; apiKey?; adapter?: Adapter | 'auto' }) → ProbeResult`.
  - Auto order: `systemone` → `decide` → `openai-logprobs` (checks logprobs support) → `openai-chat` (S2 only).
  - Sends a tiny canned decision (`choice` over 3 options + `noul`) and measures latency (3 calls → p50).
  - Capabilities: from server metadata if exposed (`GET /v1/models` or adapter-specific), else matched profile by model name, else conservative defaults (`maxOptions: 16`).
  - Image support test: send 1×1 PNG when the profile says supported; record result.
- `ProbeResult = { ok, adapter, model, capabilities, latencyMs: {p50, samples[]}, isCloud, warnings[], error? }`.
- CLI: `s1pilot probe --url http://localhost:8000 [--model …] [--key …] [--json]` prints a table matching the wizard's capability grid (adapter, max options, questions per call, images, context).

## Acceptance criteria
- [ ] Against fixture servers for each adapter, auto-detect picks the right one.
- [ ] Unreachable URL → `ok:false` with human-readable `error` within 5 s.
- [ ] CLI `--json` output validates against `ProbeResultSchema`.

## Tests
- Spin up tiny fake HTTP servers per adapter in tests.

## Out of scope
- Persisting the probe into project settings (S-032), UI (S-041).
