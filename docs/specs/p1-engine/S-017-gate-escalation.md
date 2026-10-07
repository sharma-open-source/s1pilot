# S-017 · Gate, escalation & dual-order

**Phase:** P1 · **Depends on:** S-006, S-010 · **Packages:** `@s1pilot/engine` · **Plan refs:** §4.5, §4.6, §7

## Goal
Turn model answers into an action decision using thresholds, optional System 2 second opinion, dual-order judging and a human hook.

## Scope
- `src/decide/gate.ts`: `gate(answer, { thresholds, s2?, human?, attended, sensitive }) → GateResult`:
  - `conf ≥ act` and not sensitive → `act(choice)`.
  - `escalate ≤ conf < act` → S2 `pickOption` constrained to options; agree → act (`escalatedTo:'s2'`); disagree → human (attended) or `blocked` (unattended).
  - `conf < escalate` or choice in `stuck|blocked` → human (attended) or `blocked`.
  - sensitive → always human unless environment allows the action class.
- `src/decide/dual-order.ts`: `decideDualOrder(model, req)` — second call with options reversed/shuffled (seeded); combine by averaging probabilities; flag `disagreement` if top choices differ (→ treat as below act threshold).
- `HumanHook` interface: `ask({ question, options, probabilities, screenshot?, reason }) → Promise<{ choice } | { skip } | { abort } | { takeover }>`; CLI default implementation = readline prompt in TTY, else unavailable.
- Every outcome produces a `DecisionRecord` with `escalatedTo`.

## Acceptance criteria
- [ ] Table-driven tests cover each row of plan §7 table.
- [ ] Dual-order disagreement forces escalation even when both confidences ≥ act.
- [ ] Unattended run never awaits a human; returns `blocked` with reason.

## Tests
- Pure unit tests with mock model/S2/human.

## Out of scope
- WebSocket human control (S-037), sensitive-action classification (S-018).
