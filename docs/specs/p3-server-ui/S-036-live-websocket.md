# S-036 · Live events & screencast WebSocket

**Phase:** P3 · **Depends on:** S-034 · **Packages:** `apps/server`, `@s1pilot/runner` · **Plan refs:** §8.3

## Goal
The UI can subscribe to a run and receive `RunEvent`s plus a live JPEG screencast of the active page.

## Scope
- Endpoint `GET /ws/runs/:runId` (WebSocket). Messages JSON `{ type: 'event', event: RunEvent }` and binary frames for screencast with a small header (`resultId`, frame seq, width, height).
- Event bus → per-run fan-out; late joiners get a snapshot `{ type:'snapshot', run, currentCase, steps, lastDecision }` then live events.
- Screencast: Chromium `CDPSession` `Page.startScreencast({ format:'jpeg', quality: 60, maxWidth: 1280 })`, ack frames, throttle to ≤ 10 fps; Firefox/WebKit fallback: screenshot every 1 s. Start only while ≥ 1 subscriber.
- Overlay data event `observation.elements` (ids, boxes, labels, chosen id) for the element box overlay.
- Also `GET /ws/workspace` for lightweight global events (run status changes, review counts) used by nav badges and dashboard.

## Acceptance criteria
- [ ] Test client receives ordered events for a mock run from `run.started` to `run.finished`.
- [ ] Screencast frames arrive while subscribed and stop within 1 s after unsubscribe.
- [ ] Reconnect mid-run receives snapshot then continues.

## Tests
- WebSocket integration tests with `ws` client.

## Out of scope
- Control messages (S-037), UI (S-045).
