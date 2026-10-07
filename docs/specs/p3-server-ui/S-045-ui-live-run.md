# S-045 · UI: run launcher & live run

**Phase:** P3 · **Depends on:** S-037, S-044 · **Packages:** `apps/web` · **Plan refs:** §8.1 Run launcher, Live run view, §8.3
**UI:** wireframe [`docs/wireframes/06-live-run.html`](../../wireframes/06-live-run.html) · design.md §5 row 06, §4.2 live components

## Goal
Watch a run in real time and steer it: screencast with element boxes, S1 decision panel with probabilities, approval controls and event log.

## Scope
- `RunLauncherDialog` (reusable from cases list, editor, dashboard): cases (preselected), environment, browser, mode (Replay first, heal with S1 / Explore everything / Replay only), attended toggle, build ref.
- Route `/p/:key/runs/:runId/live`; connects `/ws/runs/:runId` (reconnect with backoff; snapshot handling).
- Header card: running dot + "Plan/Case · run #n", meta "env · browser · worker x of n · case x of n", `RunProgressBar` + legend counts, Pause/Resume (secondary), Abort (danger-outline + confirm).
- Left: `StepStatusList` for current case (key, title, params label; steps with ✓/●/✗/○ and mode suffix), "Up next" list.
- Center: `BrowserFrame` rendering screencast frames to `<canvas>` (or `<img>` blob URL swap), URL from events; `ElementBoxOverlay` scaled to frame size from `observation.elements` events (chosen = solid primary, candidates dashed), toggle via "Toggle element boxes"; "Take over browser" (sends `takeover`; button becomes "Release control"); "Console · Network" opens a drawer with live console/network events.
- Right: `DecisionPanel` (`aria-live`): "Decision · step N", model · latency, question text, top 5 `ProbabilityBar`s, threshold callout (`Below act threshold (0.80)` + S2 result sentence), buttons **Approve eN** / Pick another (opens list of all options incl. meta actions) / Skip step, checkbox "Save approved choice into learned script". Keyboard A/P/S within panel. Idle state when no escalation: shows last decision read-only.
- Bottom: `EventLog` (`role=log`) formatting events as one-liners like the artboard; escalation lines in warning-log colour; autoscroll unless user scrolled up.
- On `run.finished` show banner with link to report.

## Acceptance criteria
- [ ] With a mock low-confidence run, the panel shows options + probabilities and Approve resumes the run.
- [ ] Overlay boxes align with frame at different panel widths (scale test).
- [ ] Three columns wrap gracefully at < 1100 px and stack at 400 px.
- [ ] Reload mid-run restores state from snapshot.

## Tests
- Component tests with fake WS; Playwright e2e on fixture run (mock model).

## Out of scope
- Manual execution (S-055).
