# S-019 · Explore step loop & trace

**Phase:** P1 · **Depends on:** S-013, S-014, S-015, S-016, S-017, S-018 · **Packages:** `@s1pilot/engine` · **Plan refs:** §6 per-step loop, §2.3 Explore

## Goal
Execute one natural-language test step end to end with System 1 deciding every action, writing a structured trace.

## Scope
- `src/loop/explore-step.ts`: `exploreStep(ctx, step) → StepExecution` implementing plan §6 pseudocode:
  1. `obs = observer.capture(page)`
  2. `candidates = narrow(...)`
  3. `s1.decide({ next_action: choice(candidates + meta), step_done: noul("Has this test step's action been fully performed?"), blocked: noul("Is progress blocked (error, login wall, captcha)?") })`
  4. If `step_done` ≥ act → finish; `blocked` ≥ act → blocked; else `gate(next_action)` → resolve input if needed (S-016) → guards → `execute`.
  5. Repeat until done / blocked / budget.
- `src/trace/writer.ts`: JSONL trace per case (`trace.jsonl`): observation summary (no secrets), questions, answers, gate result, action, outcome, timings. `TraceWriter` interface so runner can redirect to artifact store later.
- Emits `RunEvent`s through an injected `emit(event)` callback.
- `EngineContext = { page, s1, s2?, human?, vars, params, environment, thresholds, caps, redactor, emit, trace, budgets }`.

## Acceptance criteria
- [ ] With MockDecisionModel scripted per step, the plan §1.2 case's 4 steps complete on `/shop`.
- [ ] Step "Stop before payment" + guard: payment submit never executes.
- [ ] Trace lines validate against a `TraceLineSchema`; contain no secret values.
- [ ] Events emitted in order: step.started → decision.made… → step.finished.

## Tests
- Fixture-site integration tests with scripted mock; budget/loop termination tests.

## Out of scope
- Expected-result verification (S-020/S-021), learned script (S-023).
