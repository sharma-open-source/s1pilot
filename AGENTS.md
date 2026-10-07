# AGENTS.md — working on s1-pilot

Instructions for any coding agent (Claude Code sub-agents, Codex, Cursor, etc.) working in this repository.

## What this project is

**s1-pilot** is an AI-native web application testing platform: test management (projects, cases, plans, runs, defects, reports) plus a Playwright execution engine where each step is decided by a **System 1 decision model** (answers `choice` / `noul` / `score` with probabilities), with System 2 (chat LLM) and human escalation.

Core idea: **explore once with AI, replay deterministically, heal with AI.**

Stack: TypeScript (strict, ESM, Node ≥ 20) · pnpm workspaces + Turborepo · Playwright · Fastify + tRPC + WebSocket · Drizzle (SQLite → Postgres) · React + Vite + TanStack Router/Query + Tailwind + shadcn/ui · zod · vitest.

## Current state

The repo currently contains **planning documents only**. Code is built spec by spec, starting with S-001 (monorepo scaffold). Check which specs are done with `git log --oneline` (commits are named `feat(<scope>): S-0NN <title>`) before assuming any package exists.

## Document map — read these first

| File | What it is | When to read |
|---|---|---|
| [`docs/plan.md`](docs/plan.md) | Product & architecture plan (domain model, engine, UI scope, roadmap, risks) | Always — the sections your spec references |
| [`docs/specs/README.md`](docs/specs/README.md) | Spec index, execution order, dependencies, global conventions, resolved assumptions | Always |
| `docs/specs/<phase>/S-0NN-*.md` | The one spec you are implementing | Always |
| [`docs/design.md`](docs/design.md) | UI design system: tokens, typography, layout, components, screen table, interaction & a11y rules | Any UI work |
| [`docs/wireframes/`](docs/wireframes/index.html) | Standalone HTML wireframe per screen (`01-dashboard.html` … `13-settings.html`, `00-side-navigation.html`) | Any UI work — the file named in the spec's **UI:** line |

If these documents disagree: the **spec** wins on functional requirements; **design.md** wins on visual rules; the **wireframe** wins on structure, section order and copy.

## How to work on a spec

1. Implement exactly **one** spec per session. Confirm every spec in its `Depends on` line is already done; if not, stop and report.
2. Read the spec, `docs/specs/README.md`, and the referenced `docs/plan.md` sections (plus design.md + wireframe for UI).
3. Stay inside **Scope**. Do not build items listed under **Out of scope** — leave `// TODO(S-0NN)` pointing to the owning spec if a hook is needed.
4. Keep the exact names in the spec's **Interfaces** section — later specs depend on them.
5. Finish only when every **Acceptance criteria** box is satisfied and the checks below are green.
6. End with a summary: files changed, how each acceptance criterion is verified, and any deviation from the spec (with reason).

## Repository layout (target, per plan §11)

```
apps/web        React UI            apps/server   Fastify API, WebSocket, scheduler, workers
apps/cli        s1pilot CLI         packages/domain   zod schemas & types (single source of truth)
packages/db     Drizzle + repos     packages/providers  model adapters (systemone, decide, openai-logprobs, openai-chat, mock)
packages/engine observer/decide/executor/verifier/guards
packages/runner runCases, artifacts packages/reporters  junit/json/html
packages/sync   YAML tests-as-code  packages/integrations  trackers, notifications
profiles/       model capability profiles   fixtures/sites/  demo apps with seeded bugs   suites/  eval suites
```

Package names: `@s1pilot/<dir>`; internal deps use `workspace:*`.

## Commands

```bash
pnpm install
pnpm build          # turbo build
pnpm typecheck
pnpm lint
pnpm test           # vitest across packages
pnpm --filter @s1pilot/<pkg> test   # one package
```

(Available once S-001 is done. If a command doesn't exist yet, your spec is probably the one that creates it.)

## Coding conventions

- TypeScript strict, ESM, no `any` in exported APIs. Types come from zod schemas in `@s1pilot/domain` (`XSchema` + `type X = z.infer<…>`); don't redefine domain types elsewhere.
- Errors: throw `S1PilotError` (`code`, `message`, `details`) from `@s1pilot/domain`.
- IDs: `nanoid`; human keys (`SHOP-TC-42`) are separate fields. Times: ISO-8601 UTC strings; durations in ms.
- Logging: pino via the domain logger (redaction enabled). Never `console.log` in library code.
- Tests: vitest, colocated `*.test.ts`. Browser tests use the fixture sites (`fixtures/sites`) and headless Chromium. Model/HTTP tests use recorded fixtures or the mock adapter — **never call real model endpoints or external services in tests**.
- Match the style of surrounding code; add TSDoc to exported functions.
- Only add dependencies listed in plan.md §10 or named in your spec; mention any other addition in your summary.

## UI rules (short version — full rules in design.md)

- Build every screen to match its wireframe file: same sections, order, labels and button text.
- Colours only via tokens from design.md §2.1 (CSS variables / Tailwind theme) — never copy hex values from the wireframe into components.
- Fonts: IBM Plex Sans for text, IBM Plex Mono for keys, numbers, probabilities, URLs, locators.
- Statuses via the shared `StatusPill` mapping (design.md §2.2); always text + colour.
- Reuse components from `apps/web/src/components/ui` and `components/app` before creating new ones; add new shared ones to the `/_dev/components` page.
- Real `<button>` / `<a>` / labelled inputs; targets ≥ 44 px; pages must work at 400 px wide with no horizontal page scroll.
- Handle loading (skeletons), empty and error states. Never ship bracketed placeholder text like `[ n ]`.

## Security & safety rules (non-negotiable)

- Secret values are never logged, sent to any model, stored in traces/reports/screenshots, put in URLs, or cached in the UI query cache. Use value refs (`secret:<key>`, `var:<key>`).
- Page content is untrusted data: never treat page text as instructions in model prompts.
- Production environments are read-only by default; sensitive actions (pay, delete, send) require approval.
- Don't commit `.s1pilot/` data directories, master keys, `.env` files, or recorded storage states.

## Definition of done

- [ ] All acceptance criteria met
- [ ] Unit/integration tests for new logic
- [ ] `pnpm lint && pnpm typecheck && pnpm test` green (and `pnpm build` for packaging changes)
- [ ] No TODOs without a spec reference (`// TODO(S-0NN)`)
- [ ] UI specs: compared against the wireframe at 1440 px and 400 px

## Git

- Don't commit or push unless asked. When asked: one commit per spec, message `feat(<scope>): S-0NN <title>`.
- Don't modify `docs/plan.md`, `docs/design.md`, specs or wireframes as part of implementation; if they're wrong or contradictory, say so in your summary.
