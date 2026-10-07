# S-042 · UI: environments, secrets & login setup

**Phase:** P3 · **Depends on:** S-041, S-038 · **Packages:** `apps/web` · **Plan refs:** §8.1 Environments, Test data, §7 guards
**UI:** wireframe [`docs/wireframes/09-environments.html`](../../wireframes/09-environments.html) · design.md §5 row 09

## Goal
Manage per-environment URLs, variables, secrets, test data, login setups and safeguards.

## Scope
- Route `/p/:key/environments/:env`; env `Tabs` with `prod` showing danger "read-only" label when `readOnly`; "+ Add environment" (dialog), **Save changes** (dirty-state aware, disabled when clean).
- General card: Base URL, Allowed domains (comma list → chips on blur), Default browser (Chromium/Firefox/WebKit × viewport presets), Locale & timezone.
- Variables & secrets table: Key (mono), Value (mono; secrets masked `••••••••••` + Reveal button → `environments.revealSecret`, re-mask on blur/navigation), Type (Variable / Secret · encrypted / Secret · env tags), Sent to models ("Key + value" / danger "Key name only"); "+ Add" dashed button → inline row editor with type select.
- Test data sets grid: cards with name, rows, usage; "Upload CSV / JSON" (multipart to server `/api/projects/:key/datasets`, preview dialog of first 20 rows).
- Aside: Login setup items (name mono, status Valid/Expired pill-text, meta), "Record a login" / "Refresh now"; Test mailbox (read-only info for now); Safeguards checkboxes (Read-only, Approve payments/deletes/sends, Block navigation outside allowed domains).

## Acceptance criteria
- [ ] Revealed secret is not cached in TanStack Query cache after re-mask (test inspects cache).
- [ ] Saving updates only changed fields; validation errors shown inline.
- [ ] Record a login opens the recording flow and status changes to Valid after finish.

## Tests
- Component + e2e.

## Out of scope
- Mailbox integration (later).
