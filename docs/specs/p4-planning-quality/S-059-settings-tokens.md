# S-059 · Settings shell & API tokens

**Phase:** P4 · **Depends on:** S-039 · **Packages:** `apps/server`, `apps/web` · **Plan refs:** §8.1 Admin › Settings, §12, §13
**UI:** wireframe [`docs/wireframes/13-settings.html`](../../wireframes/13-settings.html) · design.md §5 row 13

## Goal
Workspace settings area with section navigation, API tokens for CLI/CI, retention and workers info; integration cards are placeholders until P6.

## Scope
- Route `/settings/:section`, vertical section nav: General (workspace name, default timezone), Models & endpoints (workspace default model settings — reuse S-041 models form components), Integrations (card grid per artboard; cards show real status once S-063–S-065 land, otherwise "Not connected" + disabled), Notifications (placeholder until S-065), Users & roles (read-only role description boxes + "Available in team mode"), Data & retention (default retention days, purge now per project with confirm), Workers (list in-process workers, status, current job), API tokens & CLI, Audit log (placeholder until S-067).
- API tokens: `tokens.create({name, scopes: ['runs:write','results:read']})` → shows token once; stored hashed (argon2/scrypt); `tokens.list/revoke`. Fastify auth hook accepts `Authorization: Bearer` tokens for `/api` + tRPC in addition to local session.
- "Run from CI or terminal" `CodeBlock` with copy button, prefilled with server URL and selected plan name.

## Acceptance criteria
- [ ] Token shown once, then only prefix visible; revoked token gets 401.
- [ ] Purge now removes artifacts for the project (S-035 purge).
- [ ] Section nav matches artboard order and stacks on narrow widths.

## Tests
- API + component tests.

## Out of scope
- Integrations' functionality (S-063–S-065), users/RBAC (S-067).
