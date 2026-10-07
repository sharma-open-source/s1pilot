# S-040 · UI: workspace dashboard

**Phase:** P3 · **Depends on:** S-039, S-034 · **Packages:** `apps/web`, `apps/server` · **Plan refs:** §8.1 Home
**UI:** wireframe [`docs/wireframes/01-dashboard.html`](../../wireframes/01-dashboard.html) · design.md §5 row 01

## Goal
The home screen showing projects, recent runs, review count and execution-mode mix.

## Scope
- Server: `dashboard.summary()` → `{ passRate7d, passRateSeries[7], runsToday, runningNow, needsReview, flaky, quarantined, modeMix7d: {replay, heal, explore} }`; `runs.recent(limit 8)`.
- Page `/`: header (Search input — navigates to `/search?q=` placeholder page, "New project" secondary link, **Run a plan** primary link → plan list or run launcher dialog if no plans), 4 `StatTile`s (pass rate + sparkline using Recharts tiny line, runs today + "watch" link to the live run, needs review in warning tone + "open queue", flaky + quarantined), Projects table (Project link → cases, Environments, Cases, Last run, System 1 model mono, Status pill), Recent runs list (`ResultListItem`-like rows, running rows link to live view), `ModeMixBar` with caption.
- Live updates via `/ws/workspace` invalidating queries.
- Empty states: no projects → EmptyState "Create your first project" → wizard.

## Acceptance criteria
- [ ] Layout, order and copy match the artboard; tiles wrap at narrow widths.
- [ ] Running run row shows `staging · Chromium · step x/y` and updates live.
- [ ] Mode mix segments widths equal percentages from API.

## Tests
- Component tests with mocked tRPC; Playwright e2e with seeded DB.

## Out of scope
- Global search implementation (later).
