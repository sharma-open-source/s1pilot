# S-052 · Scheduler & webhook trigger

**Phase:** P4 · **Depends on:** S-051 · **Packages:** `apps/server` · **Plan refs:** §2.2 schedule, §12 Webhook trigger

## Goal
Plans run on cron schedules and on inbound "deployment finished" webhooks.

## Scope
- Scheduler (`croner`): loads enabled plan schedules on start and on plan change; creates runs with `trigger: 'schedule'`; skip if previous scheduled run of the same plan still running (configurable).
- Timezone per plan (default workspace TZ).
- Inbound webhook: `POST /api/hooks/plans/:planId/:token` (token per plan, regenerable) with optional JSON `{ buildRef, environment, commit }`; creates run with `trigger: 'webhook'`.
- `triggers` router: `regenerateToken(planId)`, `upcoming(projectKey)` (next 10 scheduled runs).

## Acceptance criteria
- [ ] Fake-clock test: plan with `0 2 * * 1-5` triggers on weekdays at 02:00 only.
- [ ] Webhook with wrong token → 404; correct → 202 + run id.
- [ ] Overlap policy respected.

## Tests
- Unit tests with fake timers; API tests.

## Out of scope
- Outbound notifications (S-065), CI templates (S-063).
