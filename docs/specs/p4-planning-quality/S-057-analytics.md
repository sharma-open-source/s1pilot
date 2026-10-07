# S-057 · Analytics (API + UI)

**Phase:** P4 · **Depends on:** S-056 · **Packages:** `apps/server`, `apps/web` · **Plan refs:** §2.7 Dashboards, AI quality
**UI:** wireframe [`docs/wireframes/12-analytics.html`](../../wireframes/12-analytics.html) · design.md §5 row 12, §4.4

## Goal
Trends and quality metrics for a project, including AI model quality.

## Scope
- Server `analytics` router (filters: range 7/30/90 days, environment, suite): `passRateSeries` (by environment, daily), `resultsBySuite` (passed/review/failed counts), `flakyTop(10)`, `slowestTop(10)` (avg duration + dominant mode), `modeMix`, `aiQuality` (escalation rate to S2/human, needs-review rate, override rate, ECE (from S-058 if present else computed raw), decision latency p50/p95, heal success rate), `releaseReadiness(planId)` (latest run per plan + criteria), `coverage` (requirements × cases × last result).
- Pre-aggregation: daily rollup table updated on run finish to keep queries < 200 ms on 100k results.
- Page `/p/:key/analytics/:view` (`quality|readiness|coverage|ai`): header filter dropdown buttons + Export (CSV of current view); Quality view per artboard (line chart, stacked bars + legend, Most flaky with "Quarantine list" link, Slowest cases); AI model quality card (6 StatTiles + "Recalibrate from n reviewed decisions" button → S-058 + last tuned date); Readiness view: plans with criteria status; Coverage view: requirement matrix table.
- Charts per design.md §4.4 with empty states and accessible summaries.

## Acceptance criteria
- [ ] Seeded 30-day data renders all charts; filters change data.
- [ ] Queries meet 200 ms on generated 100k-result dataset (bench test).
- [ ] Charts use tokens only.

## Tests
- API tests on seeded data; component tests with chart snapshots.

## Out of scope
- Cross-model leaderboard UI ("Compare models" links to Settings › Models; simple table from eval results is fine).
