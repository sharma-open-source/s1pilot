# Plan: S1-Pilot — AI-Native Web Application Testing Platform on System 1 Decision Models

> Working name: **s1-pilot**. TypeScript / Node, Playwright, pluggable System 1 decision model behind a user-configured endpoint (local or cloud), with a web UI for projects, test cases, test plans, runs and reports.
>
> v2 of this plan: extends the original RPA agent into a full test management + execution application. The agent engine (Part B) is unchanged in spirit; Parts A, C and D are new.

---

## 0. Product summary

| Layer | What it is |
|---|---|
| **Test management** | Projects, environments, requirements, test suites, test cases, test plans, runs, defects, reports |
| **Execution engine** | Playwright runner where each step is decided by a System 1 model (with System 2 / human escalation), plus deterministic replay of previously learned steps |
| **UI** | Local-first web app (and optional desktop wrapper) for authoring, running, watching live, reviewing and reporting |
| **Integrations** | CLI + CI/CD, JUnit/Allure reports, issue trackers, notifications, imports/exports |

Core idea: **"Explore once with AI, replay deterministically, heal with AI."** A test case is written in plain language; the first run is driven by the System 1 model, the resolved steps (locators + actions) are cached, and later runs replay them fast and deterministically, calling the model only when something changed or a verdict needs judgement.

---

# PART A — Application & Test Management

## 1. Domain model

```
Workspace
 └── Project
      ├── Environments (dev / staging / prod: base URLs, variables, secrets, auth setup)
      ├── Model settings (System 1 + System 2 endpoints; inherit from workspace)
      ├── Requirements / User stories (optional, for traceability)
      ├── Shared steps / Flows (reusable: "Log in as {role}", "Add item to cart")
      ├── Test data sets (CSV/JSON tables, per environment)
      ├── Test Suites (folders, nestable)
      │    └── Test Cases (versioned)
      │         ├── Preconditions, tags, priority, owner, linked requirements
      │         ├── Steps: action (natural language) + expected result
      │         ├── Assertions: AI-judged and/or deterministic
      │         ├── Parameters (data-driven)
      │         └── Learned script (cached resolved steps, per environment)
      ├── Test Plans (selection of cases/suites × environments × browsers, schedule, owner)
      │    └── Test Runs
      │         └── Case Results → Step Results → Evidence (screenshots, video, trace, logs, S1 probabilities)
      ├── Defects (local or synced to Jira/Linear/GitHub)
      └── Reports & Analytics
```

### 1.1 Key entities (abridged)

| Entity | Important fields |
|---|---|
| `Project` | name, key (e.g. `SHOP`), default environment, model settings, retention policy |
| `Environment` | name, baseUrl, variables, secrets (encrypted refs), allowDomains, authSetup (flow id), browser matrix |
| `TestCase` | key (`SHOP-TC-42`), title, suite, priority (P0–P3), type (smoke/regression/e2e/exploratory), status (draft/ready/deprecated), tags, preconditions, steps[], parameters, version, owner |
| `Step` | order, action text, expected result text, optional deterministic assertions, optional input refs, optional `sharedStepId` |
| `LearnedScript` | caseVersion, environment, resolved actions (locator candidates, action, value ref), fingerprint of page per step, created from runId, health |
| `TestPlan` | name, release/milestone, case selection (static list or tag query), environments, browsers/devices, retries, parallelism, schedule (cron), approvers |
| `TestRun` | plan, trigger (manual/schedule/CI/webhook), commit/build ref, status, start/end, summary counts |
| `CaseResult` | verdict (passed / failed / blocked / skipped / flaky / needs-review), confidence, duration, mode used (replay / healed / ai-explore), escalations |
| `StepResult` | decision record (state, options, probabilities, chosen), action taken, assertion verdicts, evidence links, latency |
| `Defect` | title, severity, linked results, external tracker id, status |

### 1.2 Tests as code (two-way sync)
- Every project can be exported to / imported from a git-friendly folder (`.s1pilot/` with YAML per case, plan, environment; secrets excluded).
- UI edits and git edits round-trip; conflicts resolved by version number and shown as a diff in the UI.
- Lets teams review test changes in pull requests and run the same tests from CI without the UI.

Example test case file:

```yaml
# .s1pilot/suites/checkout/tc-042-guest-checkout.yaml
key: SHOP-TC-42
title: Guest can check out a single item
priority: P1
type: e2e
tags: [checkout, guest, smoke]
requirements: [SHOP-REQ-7]
preconditions:
  - flow: clear-cart
parameters:
  - { size: M, colour: blue }
  - { size: L, colour: black }
steps:
  - action: Search for "t-shirt" and open the "Classic Tee" product
    expected: The product page for Classic Tee is shown
  - action: Choose colour {colour} and size {size}, then add to cart
    expected: Cart badge shows 1 item
    assert:
      - type: elementText
        role: status
        contains: "1"
  - action: Go to checkout as guest and fill the shipping form
    inputs: [shipping_name, shipping_zip]
    expected: The payment step is displayed
    assert:
      - type: urlMatches
        pattern: "/checkout/payment"
  - action: Stop before payment
    expected: No order has been placed
```

## 2. Test lifecycle features

### 2.1 Authoring
- **Manual authoring** in a step editor (action + expected result per row), with autocomplete for shared steps, inputs and parameters.
- **Record mode**: user clicks through the app in a headed browser; the recorder captures actions and the UI turns them into natural-language steps (System 2 writes the step text; System 1 cannot generate text) and a learned script at the same time.
- **AI generation (System 2 required)**: from a user story / requirement / acceptance criteria → draft test cases; from exploring a URL → suggested smoke tests. Always created as `draft` for human review.
- **Import**: CSV, Gherkin `.feature`, TestRail/Xray/Zephyr exports, existing Playwright specs (as learned scripts).

### 2.2 Planning
- Test plans per release or sprint; selection by explicit list or saved query (`tags:smoke AND priority<=P1`).
- Matrix: environments × browsers (Chromium/Firefox/WebKit) × devices (Playwright device descriptors for mobile web).
- Assignment to people for manual or review-heavy cases; due dates; entry/exit criteria (e.g. "100% P0 passed, no open S1 defects").

### 2.3 Execution modes
| Mode | When | Model usage |
|---|---|---|
| **Replay** | Learned script exists and page fingerprints match | None (or only for AI-judged assertions) |
| **Heal** | A replayed locator fails or the page changed | S1 re-resolves only the broken step; healed script saved as a proposal for review |
| **Explore** | No learned script yet, or replay is disabled | S1 drives every step (Part B) |
| **Manual / hybrid** | Tester executes steps in the UI, marks pass/fail; AI can pre-run and pre-fill | Optional |
| **Exploratory** | Free session with a goal ("try to break the signup form"); notes + recordings captured | S1/S2 suggestions |

### 2.4 Verdicts & assertions
- **Deterministic assertions** (preferred when possible): URL, title, element visible/text/value/count, network response status, console errors, download exists, API check.
- **AI-judged assertions**: each `expected` text becomes an S1 `noul` question ("Is this scenario one where: the cart badge shows 1 item?") on the post-step state (a11y text, optionally screenshot).
- **Verdict policy**: P(true) ≥ pass threshold → pass; ≤ fail threshold → fail; in between → `needs-review` (goes to the review queue). Thresholds per project, validated from review outcomes.
- **Dual-order / repeated judging** for critical assertions to reduce order sensitivity.
- Every AI verdict stores its probabilities and evidence so a human can audit and override; overrides feed calibration.

### 2.5 Stability & maintenance
- Retries with flakiness detection (pass-after-retry → `flaky`), quarantine list, flakiness score per case.
- Learned-script health: heal frequency, last healed, proposals pending review.
- Impact view: when a heal proposal is approved, show other cases sharing the same step/flow.

### 2.6 Defects & traceability
- One click from a failed result → defect with steps, expected vs actual, screenshots, trace, environment, build ref (local, or pushed to Jira/Linear/GitHub Issues).
- Requirements ↔ cases ↔ runs ↔ defects; coverage matrix per release.
- Re-test: when a linked defect is closed, auto-queue its failed cases.

### 2.7 Reporting & analytics
- Run report: summary, per-case results, step timeline with screenshots, video, Playwright trace viewer link, console/network logs, S1 decision panel (options + probabilities).
- Dashboards: pass rate over time, by suite/environment/browser; flaky top-10; slowest cases; defect trend; release readiness against exit criteria.
- AI quality: escalation rate, needs-review rate, override rate, calibration (ECE), decision latency, mode mix (replay vs heal vs explore).
- Exports: JUnit XML, Allure, JSON, HTML (self-contained), PDF summary.

## 3. Other "proper testing" capabilities (beyond functional E2E)

| Capability | Approach | Priority |
|---|---|---|
| Accessibility checks | `@axe-core/playwright` scan per page or step; violations as warnings/failures | v1 |
| Visual regression | Screenshot baselines per case/step/browser with diff threshold; approve new baseline in UI; optional S1 `noul` "Is this difference meaningful?" to cut noise | v1.x |
| Console / network health | Fail on uncaught JS errors, 5xx responses, failed requests (configurable allow-list) | v1 |
| API steps & setup | `request` context steps for seeding data, checking backend state, teardown | v1 |
| Performance smoke | Web Vitals (LCP, CLS, INP) and page load time thresholds per page | v1.x |
| Cross-browser / device | Playwright projects matrix; mobile emulation | v1 |
| Security smoke | Basic header checks, mixed content, open redirects (not a pentest tool) | later |
| Localization | Run cases per locale; S1 assertions are language-tolerant (Laya multilingual) | later |
| Email / OTP flows | Pluggable mailbox (Mailpit/Mailosaur) for verification links and codes | v1.x |

---

# PART B — Execution Engine (System 1 agent)

## 4. What System 1 models imply

1. **They answer, they don't write.** Outputs are `noul` (true/false), `choice` (one option), `score` (ordinal). Text values must come from test data/inputs or System 2.
2. **The action space must be enumerated**: each step is "pick one of these elements / meta actions".
3. **Option count is model-dependent** (JEV up to 256; Laya degrades above ~20) → capability profiles + coarse-to-fine narrowing.
4. **Element text beats pixels.** The JEV computer-use demo reached 95% with numbered boxes plus element text vs 10–37% with boxes alone → accessibility text is primary; screenshots secondary.
5. **Probabilities are first-class**: act/pass above validated thresholds, escalate or mark `needs-review` otherwise. Some models (Laya) ship over-confident → calibrate.
6. **Order sensitivity** (~7% of 16-option answers) → dual-order for critical decisions.
7. **No single API**: `/v1/systemone` (Clef, Laya, TypeSafe Jev), `/v1/decide` (JEV), or logprob math on `/v1/chat/completions` → adapter layer.

Reference models: `Cloudflare/clef` (+ `clef-flash`), `autotrust/JEV-27B-VL` (+ `JEV-9B`), `convaiinnovations/laya`. Users can register any compatible model.

## 5. Provider layer

```ts
type Question =
  | { type: "noul";   instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score";  instructions: string; criteria: string[] };

interface DecisionModel {
  capabilities: { maxOptions: number; multiQuestionPerCall: boolean; supportsImages: boolean;
                  maxContextTokens: number; orderSensitive: boolean };
  decide(req: { state: unknown; images?: ImagePart[]; questions: Record<string, Question> })
    : Promise<Record<string, { choice?: string; score?: number; noul?: number;
                               probabilities: Record<string, number>; confidence: number }>>;
}
```

| Adapter | Endpoint | For |
|---|---|---|
| `systemone` | `POST {baseUrl}/v1/systemone` | Clef, Laya (`laya-serve`), TypeSafe Jev |
| `decide` | `POST {baseUrl}/v1/decide` | JEV family; one question per call, fanned out in parallel |
| `openai-logprobs` | `/v1/chat/completions` with `max_tokens:1`, logprobs, `allowed_token_ids`, `top_k:0`, `top_p:1` | Plain vLLM serving of decision models (advanced) |
| `openai-chat` | `/v1/chat/completions` | **System 2**: test generation, step text, free-text inputs, second opinion |
| `mock` | in-process | Unit tests, UI demos |

Model settings are editable in the UI (workspace default, project override) with a **Test connection / Probe** button that detects adapter type, capabilities and latency.

## 6. Observation → decision → action loop

**Observer** (per step): interactive elements via accessibility snapshot + DOM query, filtered to visible/enabled; short ids `e1…eN` mapped to Playwright locators (prefer `getByRole`); descriptors (role, name, text, placeholder, value state, landmark); page context (URL, title, headings, alerts, dialogs); last K actions; optional Set-of-Marks screenshot (≤448 px) when the model supports images.

**Per step in Explore/Heal mode:**
```
obs        = observer.capture(page)
candidates = narrow(obs.elements, caps.maxOptions)        // region → element
answers    = s1.decide({
  next_action: choice(candidates + scroll_down/up, go_back, step_done, stuck),
  step_done:   noul("Has this test step's action been fully performed?"),
  blocked:     noul("Is progress blocked (error, login wall, captcha)?") })
gate(answers) → act | system2 | human | mark blocked
executor.run(action) → verifier.check(expected result) → trace.write(step)
```

**Executor**: role-based action inference (click / fill / selectOption / check), stable waits (load state + DOM quiet period), popups/new tabs/dialogs/downloads, retry with fallback locator.

**Text input**: S1 picks which test-data key fits a field (`choice` over keys + `none_fits`); `none_fits` → System 2 or human. Secrets are referenced by key only and never sent to models or stored in traces.

**Learned script output**: each resolved step stores locator candidates (role+name, test id, text, CSS), action, value reference and a page fingerprint, so the next run can replay without the model.

## 7. Gating, escalation & safety

| Confidence | Behaviour |
|---|---|
| ≥ act threshold | Act automatically |
| between thresholds | Ask System 2 constrained to an option id; agree → act, disagree → human |
| below threshold / `stuck` / `blocked` | Pause run, notify, ask human in live view (or mark `blocked` in unattended runs) |
| sensitive action (pay, delete, send, prod env) | Always require approval unless explicitly allowed for that environment |

Guards: domain allow-list per environment; production environments read-only by default; loop detection (same state ×3), max steps, wall-clock budget; page text treated as data only (prompt-injection hygiene); secret masking in screenshots/video.

---

# PART C — User Interface

## 8. UI scope

Local-first web app launched by `s1pilot ui` (opens `http://localhost:5317`), same build deployable as a team server. Optional desktop wrapper (Tauri/Electron) later.

### 8.1 Screens

| Area | Screen | Key elements |
|---|---|---|
| **Home** | Workspace dashboard | Projects list, recent runs, failing cases, review queue count |
| **Project setup** | Create project wizard | Name/key → base URL → environments → model endpoint (probe) → auth setup (record login once) → optional import/crawl for suggested tests |
| | Environments | URLs, variables, secrets (masked), allow-domains, browser/device matrix, auth state status |
| | Model settings | S1/S2 endpoints, adapter, API key, capabilities, thresholds, Test connection, latency chart |
| | Test data | Data tables per environment, CSV upload, preview |
| **Test design** | Suite tree + case list | Folders, filters (tag/priority/status/owner), bulk edit, search |
| | Test case editor | Step grid (action / expected / assertions / inputs), shared-step picker, parameters table, version history & diff, linked requirements, "Run now", "Record steps", "Generate from story" |
| | Shared steps / flows | Reusable flows with usage count |
| | Requirements | Stories with linked cases and coverage status |
| **Planning** | Test plan builder | Case selection (list or query), matrix, retries, parallelism, schedule, exit criteria |
| **Execution** | Run launcher | Plan / ad-hoc selection, environment, browser, mode (replay/explore), build ref |
| | **Live run view** | Browser screencast, step list with status, current S1 decision panel (top options + probabilities), Approve / Pick other / Take over / Skip / Abort controls, logs |
| | Manual execution | Step-by-step checklist with pass/fail/notes/screenshot upload |
| **Results** | Run report | Summary, per-case verdicts, filters, retry/rerun failed |
| | Case result detail | Step timeline with screenshots, expected vs actual, AI verdict + probabilities, video, Playwright trace viewer, console/network, a11y issues, "Create defect", "Override verdict" |
| | Review queue | `needs-review` verdicts and heal proposals; approve/reject with diff; feeds calibration |
| | Visual baselines | Side-by-side / overlay diff, accept new baseline |
| **Insights** | Analytics | Pass-rate trends, flaky cases, slowest cases, coverage, release readiness, AI quality metrics |
| **Admin** | Settings | Users & roles, integrations, notifications, retention, audit log, export/import |

### 8.2 Key UX flows
1. **First test in 5 minutes**: create project → paste URL → probe model → write "Sign up with a new email and see the welcome page" → Run (explore) → watch live → save learned script.
2. **Fixing a failure**: run report → failed step → see screenshot + S1 probabilities → choose: approve heal / edit step / create defect / mark expected change.
3. **Release sign-off**: plan dashboard → exit criteria status → export PDF/HTML report.

### 8.3 Live view technology
- Playwright CDP session `Page.startScreencast` (Chromium) streamed as JPEG frames over WebSocket; fallback to periodic screenshots for Firefox/WebKit.
- Run events (step started, decision made, assertion verdict, escalation needed) pushed over the same WebSocket.
- Human takeover: pause the agent, user interacts via headed browser window (local) and resumes.

---

# PART D — Platform & Engineering

## 9. Architecture

```
┌────────────────────────┐   REST/tRPC + WebSocket   ┌──────────────────────────────┐
│ Web UI (React)         │ ◀───────────────────────▶ │ API server (Fastify)         │
└────────────────────────┘                           │ auth, projects, cases, plans │
┌────────────────────────┐   same API                │ runs, reports, integrations  │
│ CLI / CI (s1pilot)     │ ◀───────────────────────▶ └──────┬───────────────┬───────┘
└────────────────────────┘                                  │ jobs          │ data
                                                            ▼               ▼
                                              ┌──────────────────┐  ┌──────────────────┐
                                              │ Job queue        │  │ DB (SQLite →     │
                                              │ (SQLite/pg-boss) │  │ Postgres)        │
                                              └────────┬─────────┘  └──────────────────┘
                                                       ▼
                                    ┌────────────────────────────────────┐   ┌──────────────┐
                                    │ Runner workers (N parallel)        │──▶│ Artifact     │
                                    │ Playwright + Engine (Part B)       │   │ store (FS/S3)│
                                    └───────────────┬────────────────────┘   └──────────────┘
                                                    ▼
                                    System 1 / System 2 endpoints (local or cloud)
```

- **Local mode**: single process (API + queue + workers), SQLite, artifacts on disk. Zero external services.
- **Team mode**: Postgres, pg-boss queue, multiple worker containers, S3-compatible artifact storage, SSO.
- Workers can run on other machines (e.g. the GPU box next to the model) and register with the server.

## 10. Tech stack

| Concern | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Language | TypeScript (strict), Node 20+ |
| Browser automation | Playwright (`playwright-core`), `@axe-core/playwright` |
| API server | Fastify + tRPC (typed end-to-end) or REST with OpenAPI; `ws` for live events |
| DB / ORM | Drizzle ORM; SQLite (better-sqlite3) default, Postgres for team |
| Queue | SQLite-backed queue in local mode; pg-boss in team mode |
| Web UI | React + Vite, TanStack Router + Query, Tailwind + shadcn/ui, Monaco (YAML view), react-hook-form + zod |
| Validation | zod schemas shared between server, UI, CLI |
| Artifacts | Local FS / S3-compatible (MinIO) |
| Auth | Local single-user by default; team: email/password + OIDC SSO; roles (admin, lead, tester, viewer) |
| Secrets | Encrypted at rest (libsodium), master key from env/OS keychain |
| Logging/observability | pino, OpenTelemetry traces for runs and model calls |
| Testing the tool | vitest (unit), Playwright (UI e2e of s1-pilot itself), fixture sites, contract tests per adapter |
| Packaging | npm (`npx s1pilot`), Docker images (server, worker), optional Tauri desktop |

## 11. Repository structure

```
s1-pilot/
├── apps/
│   ├── web/                 # React UI
│   ├── server/              # Fastify API, WebSocket, scheduler
│   └── cli/                 # s1pilot run | ui | probe | eval | calibrate | sync
├── packages/
│   ├── engine/              # observer, decision engine, executor, verifier, guards
│   ├── providers/           # systemone, decide, openai-logprobs, openai-chat, mock
│   ├── runner/              # worker: job handling, replay/heal/explore, artifacts
│   ├── domain/              # zod schemas & types: project, case, plan, run, result
│   ├── db/                  # drizzle schema & migrations
│   ├── reporters/           # junit, allure, html, pdf, json
│   ├── integrations/        # jira, linear, github, slack, teams, mailbox
│   └── sync/                # tests-as-code YAML import/export
├── profiles/                # clef, clef-flash, jev, jev-9b, laya defaults
├── fixtures/sites/          # demo apps for evals and the tool's own tests
├── suites/                  # benchmark task suites
└── docs/
```

## 12. CI/CD & integrations

- `s1pilot run --plan "Smoke" --env staging --reporter junit,html` with proper exit codes; `--server` to report results back to the UI, or standalone.
- Ready-made GitHub Actions / GitLab CI templates; PR comment with summary + report link.
- Webhook trigger ("deployment finished" → run plan).
- Issue trackers: Jira, Linear, GitHub Issues (create/sync defects).
- Notifications: Slack, Microsoft Teams, email (run finished, needs-review, approval required).
- MCP server mode (later): let other agents list/run tests and read results.

## 13. Security, privacy & compliance

- On-device by default: no data leaves the machine unless the user configures a cloud model endpoint (clearly labelled in UI).
- Per-project "data policy": allow/deny screenshots to model, redact patterns (emails, card numbers) before sending state.
- RBAC, audit log of edits, approvals and overrides.
- Artifact retention policies; purge per project.
- Production-environment safeguards (read-only defaults, mandatory approval for sensitive actions).

---

## 14. Evaluation of the tool itself

- Fixture apps (shop, settings, mail, forms, dashboards) with known test cases and ground-truth verdicts, including **seeded bugs** to measure: bug detection rate, false-fail rate, false-pass rate (most dangerous), needs-review rate.
- Engine metrics: step success, heal success, replay hit rate, decision latency p50/p95, escalations.
- Model leaderboard across Clef / Clef-flash / JEV-9B / JEV-27B-VL / Laya on the same suites; results drive default profiles.
- Calibration: fit temperatures per (question type, option count) from reviewed verdicts; track ECE over time.

---

## 15. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **P1 Engine** (≈ original M0–M6) | Providers, observer, explore loop, forms, escalation, narrowing, CLI `run` from YAML | ≥70% step success on fixture suites with ≥2 models |
| **P2 Test model & replay** | Test cases/steps/assertions, learned scripts, replay + heal, verdict policy, JUnit/HTML reporters, tests-as-code | Re-run of learned cases ≥5× faster than explore; false-pass ≈ 0 on seeded bugs |
| **P3 Server + UI (local)** | Fastify + SQLite, projects/environments/model settings, case editor, run launcher, live view, run report, review queue | "First test in 5 minutes" flow works end to end |
| **P4 Planning & quality** | Test plans, matrix, scheduling, retries/flaky detection, a11y + console/network checks, defects, dashboards | A release plan can be executed and signed off in the UI |
| **P5 Authoring assist** | Recorder, System 2 test generation from stories/crawl, imports (CSV/Gherkin/TestRail) | Generated drafts accepted ≥50% with minor edits |
| **P6 Integrations & CI** | GitHub/GitLab templates, Jira/Linear/GitHub Issues, Slack/Teams, webhooks | Plan triggered from CI with results in UI and PR |
| **P7 Team mode** | Postgres, distributed workers, S3, auth/SSO, RBAC, audit log | Multi-user pilot with one team |
| **Later** | Visual regression, performance budgets, email/OTP, MCP server, desktop app, fine-tuning export | — |

---

## 16. Risks

| Risk | Mitigation |
|---|---|
| **False passes** from AI-judged assertions | Prefer deterministic assertions; needs-review band; seeded-bug evals; never auto-pass P0 on AI verdict alone (configurable) |
| Model declares step/test done too early | Separate step-done and expected-result checks; programmatic assertions |
| Flaky, slow AI-driven runs | Replay-first with learned scripts; AI only for heal and judgement |
| Option limits on large pages | Capability profiles + coarse-to-fine narrowing |
| Over-confident probabilities | Calibration from review outcomes per project |
| Scope creep (TMS + agent + UI) | Phased roadmap; P1–P3 usable without later phases |
| 27B models too heavy for laptops | Recommend Clef-flash / JEV-9B / Laya locally; 27B on LAN/cloud endpoints |
| Hostile page content | Page text is data only; approvals for sensitive actions; prod read-only |

---

## 17. Open questions

1. Target users: QA engineers only, or also developers/product people writing tests in plain language?
2. Single-user local tool first, or multi-user team server from the start?
3. Is System 2 acceptable as a required dependency for authoring features (generation, recorder step text)?
4. Which issue tracker and chat tool should be first-class (Jira? Linear? Slack? Teams?)
5. Do you need manual test execution alongside automated runs (full TMS replacement), or automation only?
6. Target hardware for on-device models (laptop CPU/Apple Silicon vs local GPU box)?
7. Must tests be stored as files in git (source of truth), or is the database the source of truth with export?
8. Are mobile native apps ever in scope (would need Appium, outside Playwright)?
