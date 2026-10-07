# S-067 · Auth, RBAC & audit log

**Phase:** P7 · **Depends on:** S-066 · **Packages:** `apps/server`, `apps/web` · **Plan refs:** §10 Auth, §13 RBAC/audit

## Goal
Multi-user team mode with email/password and OIDC SSO, four roles, and an audit log of edits, approvals and overrides.

## Scope
- Users, sessions (httpOnly cookie, rotating), password hashing (argon2), invite flow (admin creates invite link), OIDC (`openid-client`; Google/Azure/Okta generic), local mode keeps implicit admin.
- Roles: `admin` (settings, models, users), `lead` (plans, approvals, sign-off), `tester` (cases, runs, reviews), `viewer` (reports only). Permission matrix in `packages/domain/src/permissions.ts`; tRPC middleware `requirePermission`; UI hides/disables actions accordingly.
- Audit log table: actor, action, entity, before/after JSON diff (secrets redacted), ip, at; written for case edits, plan edits, approvals, overrides, heal decisions, secret reveals, settings changes, sign-offs.
- UI: login page (design tokens, single Card), Settings › Users & roles (list, invite, change role, deactivate), Settings › Audit log (filterable table, export CSV).
- Owner fields (cases, assignments) now reference real users.

## Acceptance criteria
- [ ] Viewer cannot call mutation procedures (403) and sees no edit controls.
- [ ] Every action in the list above creates an audit entry (test per action).
- [ ] OIDC login works against a mock OIDC provider in tests.

## Tests
- API permission tests; e2e login.

## Out of scope
- SCIM provisioning.
