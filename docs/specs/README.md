# s1pilot · Implementation specs

Small, sequential specs derived from [`../plan.md`](../plan.md). Each spec is sized for **one sub-agent session** (roughly 0.5–2 days of human work) and ends in a mergeable, tested state.

UI specs (those with a **UI:** line) must follow [`../design.md`](../design.md) and the matching standalone wireframe in [`../wireframes/`](../wireframes/index.html) (exported from the canvas https://claude.ai/artifact/7JqTPxRmPXkBATqh5opk6u).

## How to use with sub-agents

1. Run specs **in numeric order**. A spec may start only when every spec in its `Depends on` line is done.
2. Give the agent: this README, the spec file, `docs/plan.md`, and (for UI) `docs/design.md` + the wireframe file named in the spec's **UI:** line.
3. Prompt template:
   > Implement `docs/specs/<folder>/<file>.md` in this repo. Read `docs/specs/README.md` (conventions) and the referenced sections of `docs/plan.md` first. For UI work, also read `docs/design.md` and the wireframe HTML named in the spec's UI line, and match it. Stay inside the spec's scope; do not implement "Out of scope" items. Finish only when every acceptance criterion passes and `pnpm lint && pnpm typecheck && pnpm test` are green. At the end, list files changed and any deviations.
4. After each spec: review, commit (`feat(<scope>): S-0NN <title>`), then start the next.
5. Specs marked **∥** in the table can run in parallel with the previous one (they only share already-finished dependencies).

## Global conventions (apply to every spec)

- **Monorepo**: pnpm workspaces + Turborepo. Packages are named `@s1pilot/<dir>` (`@s1pilot/domain`, `@s1pilot/engine`, …). Apps: `apps/server`, `apps/web`, `apps/cli`.
- **TypeScript strict**, ESM, Node ≥ 20. No `any` in exported APIs. zod schemas live in `@s1pilot/domain` and are the single source of types (`z.infer`).
- **Tests**: vitest, colocated as `*.test.ts`. Browser-dependent tests use the fixture sites (S-005) and Playwright Chromium headless. Network-dependent provider tests use recorded HTTP fixtures (msw/undici MockAgent) — never real endpoints in CI.
- **Logging**: `pino` via `@s1pilot/domain/logger` helper; never log secret values.
- **IDs**: `nanoid` (21 chars) for DB ids; human keys like `SHOP-TC-42` are separate fields.
- **Time**: store ISO-8601 UTC strings; durations in ms.
- **Errors**: throw typed errors extending `S1PilotError` (`code`, `message`, `details`) from `@s1pilot/domain/errors`.
- **Do not** add dependencies outside plan.md §10 without noting it in the PR summary.
- **Definition of done**: acceptance criteria met · unit tests for new logic · `pnpm lint typecheck test` green · public functions have TSDoc · no TODOs without a spec reference (`// TODO(S-0NN)`).

## Assumptions (open questions in plan.md §17, resolved for v1)

| # | Assumption |
|---|---|
| 1 | Users: QA engineers and developers; plain-language steps for both. |
| 2 | Single-user **local mode first** (P1–P6); team mode in P7. |
| 3 | System 2 is **optional**; features that need it (generation, recorder step text, second opinion) degrade gracefully when not configured. |
| 4 | First-class integrations: **Jira**, **GitHub Issues**, **Slack**; Linear/Teams follow the same interfaces. |
| 5 | Manual execution **is** in scope (P4). |
| 6 | Reference hardware: laptop with Clef-flash / JEV-9B locally; 27B models on LAN/cloud. |
| 7 | **DB is source of truth**; `.s1pilot/` YAML is a two-way synced export. |
| 8 | Mobile native apps are out of scope (mobile web via Playwright devices only). |

Change an assumption here first, then update affected specs.

## Sequence

| # | Spec | Phase | Depends on | ∥ |
|---|---|---|---|---|
| S-001 | [Monorepo scaffold](p0-foundation/S-001-monorepo-scaffold.md) | P0 | — | |
| S-002 | [Domain schemas](p0-foundation/S-002-domain-schemas.md) | P0 | 001 | |
| S-003 | [Database schema & repositories](p0-foundation/S-003-database.md) | P0 | 002 | |
| S-004 | [Secrets vault & redaction](p0-foundation/S-004-secrets-redaction.md) | P0 | 002 | ∥ |
| S-005 | [Fixture sites](p0-foundation/S-005-fixture-sites.md) | P0 | 001 | ∥ |
| S-006 | [Provider contract, mock adapter & profiles](p1-engine/S-006-provider-contract-mock.md) | P1 | 002 | |
| S-007 | [`systemone` adapter](p1-engine/S-007-adapter-systemone.md) | P1 | 006 | |
| S-008 | [`decide` adapter](p1-engine/S-008-adapter-decide.md) | P1 | 006 | ∥ |
| S-009 | [`openai-logprobs` adapter](p1-engine/S-009-adapter-openai-logprobs.md) | P1 | 006 | ∥ |
| S-010 | [`openai-chat` System 2 adapter](p1-engine/S-010-adapter-openai-chat.md) | P1 | 006 | ∥ |
| S-011 | [Provider probe & auto-detect](p1-engine/S-011-provider-probe.md) | P1 | 007–010 | |
| S-012 | [Observer: elements & locators](p1-engine/S-012-observer-elements.md) | P1 | 002, 005 | |
| S-013 | [Observer: page context & Set-of-Marks](p1-engine/S-013-observer-context-som.md) | P1 | 012 | |
| S-014 | [Coarse-to-fine narrowing](p1-engine/S-014-narrowing.md) | P1 | 006, 013 | |
| S-015 | [Executor](p1-engine/S-015-executor.md) | P1 | 012 | ∥ |
| S-016 | [Text input resolution](p1-engine/S-016-text-input.md) | P1 | 004, 006, 015 | |
| S-017 | [Gate, escalation & dual-order](p1-engine/S-017-gate-escalation.md) | P1 | 006, 010 | |
| S-018 | [Guards](p1-engine/S-018-guards.md) | P1 | 015 | ∥ |
| S-019 | [Explore step loop & trace](p1-engine/S-019-explore-loop.md) | P1 | 013–018 | |
| S-020 | [Verifier: AI-judged assertions & verdict policy](p1-engine/S-020-verifier-ai.md) | P1 | 019 | |
| S-021 | [Deterministic assertions](p1-engine/S-021-assertions-deterministic.md) | P1 | 015 | ∥ |
| S-022 | [YAML case loader & CLI `run`](p1-engine/S-022-yaml-cli-run.md) | P1 | 019–021 | |
| S-023 | [Learned script capture](p2-replay/S-023-learned-script.md) | P2 | 022 | |
| S-024 | [Replay mode](p2-replay/S-024-replay.md) | P2 | 023 | |
| S-025 | [Heal mode & heal proposals](p2-replay/S-025-heal.md) | P2 | 024 | |
| S-026 | [Parameters & shared steps](p2-replay/S-026-parameters-shared-steps.md) | P2 | 022 | ∥ |
| S-027 | [Case runner & JUnit/JSON reporters](p2-replay/S-027-case-runner-reporters.md) | P2 | 024–026 | |
| S-028 | [HTML report](p2-replay/S-028-html-report.md) | P2 | 027 | |
| S-029 | [Tests-as-code sync](p2-replay/S-029-tests-as-code-sync.md) | P2 | 003, 026 | ∥ |
| S-030 | [Eval harness & seeded bugs](p2-replay/S-030-eval-harness.md) | P2 | 027 | |
| S-031 | [API server scaffold](p3-server-ui/S-031-server-scaffold.md) | P3 | 003 | |
| S-032 | [API: projects, environments, model settings](p3-server-ui/S-032-api-projects-envs-models.md) | P3 | 011, 031 | |
| S-033 | [API: suites, cases, versions](p3-server-ui/S-033-api-cases.md) | P3 | 032 | |
| S-034 | [Job queue, worker & run lifecycle](p3-server-ui/S-034-queue-worker-runs.md) | P3 | 027, 033 | |
| S-035 | [Artifact store & evidence capture](p3-server-ui/S-035-artifacts-evidence.md) | P3 | 034 | |
| S-036 | [Live events & screencast WebSocket](p3-server-ui/S-036-live-websocket.md) | P3 | 034 | ∥ |
| S-037 | [Human-in-the-loop control](p3-server-ui/S-037-human-in-loop.md) | P3 | 036 | |
| S-038 | [Auth setup flows (login state)](p3-server-ui/S-038-auth-setup.md) | P3 | 032, 015 | ∥ |
| S-039 | [Web scaffold, tokens & app shell](p3-server-ui/S-039-web-scaffold-shell.md) | P3 | 031 | ∥ |
| S-040 | [UI: workspace dashboard](p3-server-ui/S-040-ui-dashboard.md) | P3 | 039, 034 | |
| S-041 | [UI: new project wizard](p3-server-ui/S-041-ui-project-wizard.md) | P3 | 039, 032 | |
| S-042 | [UI: environments & secrets](p3-server-ui/S-042-ui-environments.md) | P3 | 041, 038 | |
| S-043 | [UI: test cases list & suites](p3-server-ui/S-043-ui-test-cases.md) | P3 | 039, 033 | |
| S-044 | [UI: test case editor](p3-server-ui/S-044-ui-case-editor.md) | P3 | 043 | |
| S-045 | [UI: run launcher & live run](p3-server-ui/S-045-ui-live-run.md) | P3 | 037, 044 | |
| S-046 | [UI: run report & result detail](p3-server-ui/S-046-ui-run-report.md) | P3 | 035, 045 | |
| S-047 | [Review queue (API + UI)](p3-server-ui/S-047-review-queue.md) | P3 | 025, 046 | |
| S-048 | [`s1pilot ui` & first-test E2E](p3-server-ui/S-048-cli-ui-e2e.md) | P3 | 040–047 | |
| S-049 | [Test plans API & query language](p4-planning-quality/S-049-plans-api.md) | P4 | 048 | |
| S-050 | [UI: test plan builder](p4-planning-quality/S-050-ui-plan-builder.md) | P4 | 049 | |
| S-051 | [Matrix runs, retries, flaky & quarantine](p4-planning-quality/S-051-matrix-retries-flaky.md) | P4 | 049 | ∥ |
| S-052 | [Scheduler & webhook trigger](p4-planning-quality/S-052-scheduler-webhooks.md) | P4 | 051 | |
| S-053 | [Accessibility & console/network checks](p4-planning-quality/S-053-quality-checks.md) | P4 | 035 | ∥ |
| S-054 | [Defects (API + UI)](p4-planning-quality/S-054-defects.md) | P4 | 046 | ∥ |
| S-055 | [Manual / hybrid execution](p4-planning-quality/S-055-manual-execution.md) | P4 | 054 | |
| S-056 | [Exit criteria & release readiness](p4-planning-quality/S-056-exit-criteria.md) | P4 | 051, 054 | |
| S-057 | [Analytics (API + UI)](p4-planning-quality/S-057-analytics.md) | P4 | 056 | |
| S-058 | [Calibration](p4-planning-quality/S-058-calibration.md) | P4 | 047 | ∥ |
| S-059 | [Settings shell & API tokens](p4-planning-quality/S-059-settings-tokens.md) | P4 | 039 | ∥ |
| S-060 | [Recorder](p5-authoring/S-060-recorder.md) | P5 | 023, 044 | |
| S-061 | [System 2 test generation](p5-authoring/S-061-s2-generation.md) | P5 | 010, 047 | ∥ |
| S-062 | [Importers](p5-authoring/S-062-importers.md) | P5 | 033 | ∥ |
| S-063 | [CI: CLI server mode & templates](p6-integrations/S-063-ci-cli-templates.md) | P6 | 056, 059 | |
| S-064 | [Issue trackers](p6-integrations/S-064-issue-trackers.md) | P6 | 054, 059 | ∥ |
| S-065 | [Notifications](p6-integrations/S-065-notifications.md) | P6 | 052, 059 | ∥ |
| S-066 | [Postgres & pg-boss](p7-team/S-066-postgres-pgboss.md) | P7 | 052 | |
| S-067 | [Auth, RBAC & audit log](p7-team/S-067-auth-rbac-audit.md) | P7 | 066 | |
| S-068 | [Remote workers & S3 artifacts](p7-team/S-068-remote-workers-s3.md) | P7 | 066 | ∥ |

**Later** (not specced yet, plan.md §15): visual regression, performance budgets, email/OTP mailbox, MCP server, desktop app, fine-tuning export.

## Spec template

See [`_template.md`](_template.md).
