# S-037 · Human-in-the-loop control

**Phase:** P3 · **Depends on:** S-036 · **Packages:** `apps/server`, `@s1pilot/runner` · **Plan refs:** §7, §8.1 Live run, §8.3 takeover

## Goal
Attended runs pause on escalations and the UI can approve, pick another option, skip, pause/resume, abort, or take over the browser.

## Scope
- `HumanHook` server implementation: on `gate` → human, emit `escalation.needed { escalationId, question, options, probabilities, s2Choice?, reason, thresholds }` and await a control message.
- Control messages on the run WebSocket (and tRPC mutations for non-WS clients): `approve {escalationId, choice, saveToLearned: boolean}`, `pickOther {escalationId, choice}`, `skipStep`, `pause`, `resume`, `abort`, `takeover`, `release`.
- Takeover: local mode only — relaunch/attach headed browser window for the context (or switch an already headed run); engine paused until `release`; after release a fresh observation is captured.
- Timeouts: escalation waits up to `escalationTimeoutMin` (default 30) then `blocked`.
- Every human decision persisted on `DecisionRecord` (`decidedBy: userId`, `via: 'live'`) and, when the confidence was below act, also creates a review item record for calibration (S-047/S-058).

## Acceptance criteria
- [ ] Mock run with low confidence pauses; sending `approve` continues and the learned script contains the approved choice when `saveToLearned`.
- [ ] `abort` ends run as `cancelled` and closes browsers.
- [ ] Unattended run never emits `escalation.needed` (marks blocked instead).

## Tests
- WS integration with scripted mock.

## Out of scope
- UI (S-045).
