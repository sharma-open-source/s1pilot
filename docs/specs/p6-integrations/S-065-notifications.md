# S-065 · Notifications (Slack, Teams, email) & outbound webhooks

**Phase:** P6 · **Depends on:** S-052, S-059 · **Packages:** `@s1pilot/integrations`, `apps/server`, `apps/web` · **Plan refs:** §12 Notifications

## Goal
Tell people when runs finish, approvals are needed, or the review queue grows; send results to arbitrary webhooks.

## Scope
- `Notifier` interface + implementations: Slack (incoming webhook or bot token; Block Kit message with summary + buttons linking to report/live view), Microsoft Teams (incoming webhook, Adaptive Card), Email (SMTP via nodemailer), outbound Webhook (JSON payload, HMAC signature header).
- Events: `run.finished` (with exit criteria), `approval.required` (attended escalation waiting > 1 min), `review.threshold` (queue > N), `defect.created`.
- Rules: per project/plan subscriptions (channel, events, only-on-failure toggle); plan builder "Notify Slack #qa on finish" enabled.
- Settings › Notifications page: channels list, test send, rules table. Integrations cards Slack · Teams / Webhooks show status.
- Retry with backoff; delivery log (last 100).

## Acceptance criteria
- [ ] Fake Slack endpoint receives a well-formed message on run finish.
- [ ] Outbound webhook signature verifies with shared secret.
- [ ] Failed delivery retried 3× then logged.

## Tests
- Unit tests per notifier with fake endpoints.

## Out of scope
- Chat-ops commands (later / MCP).
