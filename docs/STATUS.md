# Implementation status

Single place to see which specs are done. **Update this file at the end of every spec session** (same time as the commit). Order and dependencies live in [`specs/README.md`](specs/README.md).

Status values: `todo` · `in progress` · `implemented` (code written, checks not yet confirmed) · `done` (all acceptance criteria verified, lint/typecheck/test green) · `blocked`.

## Log

| Date | Spec | Change | Notes |
|---|---|---|---|
| 2026-10-07 | S-010 | todo → done | `openai-chat` adapter: chat, chatJson with repair, pickOption, redaction, `isCloudEndpoint`. |
| 2026-10-07 | S-009 | todo → done | `openai-logprobs` adapter: label plans, prompt rendering, logprob → probability math, warnings. |
| 2026-10-07 | S-008 | todo → done | `decide` adapter (one question per call, ≤4 parallel), wire-format doc. |
| 2026-10-07 | S-007 | todo → done | `systemone` adapter, HTTP helpers, wire-format doc. |
| 2026-10-07 | S-006 | todo → done | Contract, registry, mock + MockChatModel, normalize, fan-out, timeout/retry guard, 5 profiles. |
| 2026-10-07 | S-005 | todo → done | `@s1pilot/fixture-sites`: shop/settings/forms/mail, 5 bugs, 3 variants, ground-truth.json. **P0 complete (S-001–S-005).** |
| 2026-10-07 | S-004 | todo → done | Vault, variable resolution, redactor, logger hook. |
| 2026-10-07 | S-003 | todo → done | Drizzle schema (23 tables), migration `0000`, 12 repos, `withTx`, `seed:demo`. |
| 2026-10-07 | S-002 | todo → done | All schemas, errors, logger, ids; `pnpm build/typecheck/lint/test` green. |
| 2026-10-07 | S-001 | implemented → done | Verified by user (tests green, `--version` → 0.1.0). |
| 2026-10-07 | S-001 | todo → implemented | Files written; `pnpm install/build/typecheck/lint/test` and `node apps/cli/dist/index.js --version` **not yet run** (shell tool unavailable). No git repo yet, so no commit. |

## Specs

| Spec | Title | Phase | Status | Notes |
|---|---|---|---|---|
| S-001 | Monorepo scaffold | P0 | done | Verified by user 2026-10-07: test task green, CLI `--version` prints 0.1.0 |
| S-002 | Domain schemas | P0 | done | build/typecheck/lint/test green (48 domain tests). Added `yaml` as devDependency (test fixture only). `./errors` and `./logger` subpath exports added. |
| S-003 | Database schema & repositories | P0 | done | build/typecheck/lint/test green (28 db tests). Env fix: installed full `python3` via apt so better-sqlite3 compiles. Added domain schemas `Workspace`, `Suite`, `TestDataSet`, `HealProposal`, `ReviewItem` (minimal; S-025/S-047 may extend). Added `zod` dep to db. `openDb` needs a `crypto` (S-004) to store secret variables. |
| S-004 | Secrets vault & redaction | P0 | done | build/typecheck/lint/test green (domain 78, db 39 tests). New dep: `libsodium-wrappers` (+types) in db. `createLogger` option `redactValue` replaced by `redactor`. `createVault()` is async and its result can be passed directly as `openDb({ crypto })`. |
| S-005 | Fixture sites | P0 | done | build/typecheck/lint/test green (30 Playwright tests). New deps (fixture-sites devDeps): `playwright`, `@playwright/test` (for auto-waiting `expect`). Env fix: Chromium system libs installed via `playwright install-deps` (sudo apt). CI gained a `playwright install --with-deps chromium` step. Bugs/variants switchable by server option, `?bugs=`/`?variant=` (cookie-remembered) or `x-fixture-bugs`/`x-fixture-variant` headers. |
| S-006 | Provider contract, mock adapter & profiles | P1 | done | build/typecheck/lint/test green (51 provider tests). Added domain `ProfileSchema`. Profile capability values other than the spec'd maxOptions (JEV 256, Laya 20, Clef 64) are placeholders — confirm via probe (S-011). Real adapters call `registerDecisionAdapter`/`registerChatAdapter`. |
| S-007 | `systemone` adapter | P1 | done | build/typecheck/lint/test green (70 provider tests, local-HTTP fixtures). **Wire format is an assumption** (plan only names the endpoint) — documented in `adapters/systemone.md`; verify against a real server via S-011. New dep: `zod` in providers. Shared helpers in `util/http.ts` (`postJson`, `badResponse`, `safeSnippet`) for S-008–S-010. |
| S-008 | `decide` adapter | P1 | done | build/typecheck/lint/test green (83 provider tests). **Wire format is an assumption** (same caveat as S-007), see `adapters/decide.md`. Per-question retry lives in the adapter; errors it gives up on carry `details.retried=true` so the generic guard doesn't retry again. Shared test helper `src/test-http.ts`; shared `util/wire.ts`. |
| S-009 | `openai-logprobs` adapter | P1 | done | build/typecheck/lint/test green (102 provider tests). Added optional `tokenIds` to domain `ProfileSchema` (label → token id); `CreateModelOptions` gained `labelAlphabet` and `onWarning` (+ `ModelWarning` type); shared `retryQuestion` in `util/guard.ts`. Adapter caps `maxOptions` at the label alphabet size (36). Verified against fixtures shaped like vLLM output, not a live server. |
| S-010 | `openai-chat` System 2 adapter | P1 | done | build/typecheck/lint/test green (156 provider tests). `ChatModel` gained `chatJson(req, zodSchema)` (one repair attempt; also on `MockChatModel`). `CreateModelOptions.redactor` scrubs every prompt. `isCloudEndpoint` in `util/endpoint.ts`. No wire-format doc written (standard OpenAI chat API). |
| S-011 | Provider probe & auto-detect | P1 | todo | |
| S-012 | Observer: elements & locators | P1 | todo | |
| S-013 | Observer: page context & Set-of-Marks | P1 | todo | |
| S-014 | Coarse-to-fine narrowing | P1 | todo | |
| S-015 | Executor | P1 | todo | |
| S-016 | Text input resolution | P1 | todo | |
| S-017 | Gate, escalation & dual-order | P1 | todo | |
| S-018 | Guards | P1 | todo | |
| S-019 | Explore step loop & trace | P1 | todo | |
| S-020 | Verifier: AI-judged assertions & verdict policy | P1 | todo | |
| S-021 | Deterministic assertions | P1 | todo | |
| S-022 | YAML case loader & CLI `run` | P1 | todo | |
| S-023 | Learned script capture | P2 | todo | |
| S-024 | Replay mode | P2 | todo | |
| S-025 | Heal mode & heal proposals | P2 | todo | |
| S-026 | Parameters & shared steps | P2 | todo | |
| S-027 | Case runner & JUnit/JSON reporters | P2 | todo | |
| S-028 | HTML report | P2 | todo | |
| S-029 | Tests-as-code sync | P2 | todo | |
| S-030 | Eval harness & seeded bugs | P2 | todo | |
| S-031 | API server scaffold | P3 | todo | |
| S-032 | API: projects, environments, model settings | P3 | todo | |
| S-033 | API: suites, cases, versions | P3 | todo | |
| S-034 | Job queue, worker & run lifecycle | P3 | todo | |
| S-035 | Artifact store & evidence capture | P3 | todo | |
| S-036 | Live events & screencast WebSocket | P3 | todo | |
| S-037 | Human-in-the-loop control | P3 | todo | |
| S-038 | Auth setup flows (login state) | P3 | todo | |
| S-039 | Web scaffold, tokens & app shell | P3 | todo | |
| S-040 | UI: workspace dashboard | P3 | todo | |
| S-041 | UI: new project wizard | P3 | todo | |
| S-042 | UI: environments & secrets | P3 | todo | |
| S-043 | UI: test cases list & suites | P3 | todo | |
| S-044 | UI: test case editor | P3 | todo | |
| S-045 | UI: run launcher & live run | P3 | todo | |
| S-046 | UI: run report & result detail | P3 | todo | |
| S-047 | Review queue (API + UI) | P3 | todo | |
| S-048 | `s1pilot ui` & first-test E2E | P3 | todo | |
| S-049 | Test plans API & query language | P4 | todo | |
| S-050 | UI: test plan builder | P4 | todo | |
| S-051 | Matrix runs, retries, flaky & quarantine | P4 | todo | |
| S-052 | Scheduler & webhook trigger | P4 | todo | |
| S-053 | Accessibility & console/network checks | P4 | todo | |
| S-054 | Defects (API + UI) | P4 | todo | |
| S-055 | Manual / hybrid execution | P4 | todo | |
| S-056 | Exit criteria & release readiness | P4 | todo | |
| S-057 | Analytics (API + UI) | P4 | todo | |
| S-058 | Calibration | P4 | todo | |
| S-059 | Settings shell & API tokens | P4 | todo | |
| S-060 | Recorder | P5 | todo | |
| S-061 | System 2 test generation | P5 | todo | |
| S-062 | Importers | P5 | todo | |
| S-063 | CI: CLI server mode & templates | P6 | todo | |
| S-064 | Issue trackers | P6 | todo | |
| S-065 | Notifications | P6 | todo | |
| S-066 | Postgres & pg-boss | P7 | todo | |
| S-067 | Auth, RBAC & audit log | P7 | todo | |
| S-068 | Remote workers & S3 artifacts | P7 | todo | |
