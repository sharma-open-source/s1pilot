# Implementation status

Single place to see which specs are done. **Update this file at the end of every spec session** (same time as the commit). Order and dependencies live in [`specs/README.md`](specs/README.md).

Status values: `todo` · `in progress` · `implemented` (code written, checks not yet confirmed) · `done` (all acceptance criteria verified, lint/typecheck/test green) · `blocked`.

## Log

| Date | Spec | Change | Notes |
|---|---|---|---|
| 2026-10-08 | S-022 | todo → done | YAML case loader (`@s1pilot/sync`) + `s1pilot run` CLI (sub-agent, merged). **P1 complete (S-006–S-022).** |
| 2026-10-08 | S-023, S-026 | todo → done | Learned script capture and parameters & shared steps (parallel sub-agents, merged). |
| 2026-10-08 | S-024, S-029 | todo → done | Replay mode and tests-as-code sync (parallel sub-agents, merged). |
| 2026-10-08 | S-025 | todo → done | Heal mode & heal proposals (sub-agent, merged). |
| 2026-10-08 | S-027 | todo → done | Case runner & JUnit/JSON reporters (sub-agent, merged). Replay/heal wired into CLI. |
| 2026-10-08 | S-028, S-030 | todo → done | HTML report and eval harness (parallel sub-agents, merged). **P2 complete (S-023–S-030).** |
| 2026-10-08 | S-020 | todo → done | `verifyStep`, `judgeExpected`, `verdictFor`/`caseVerdict` (sub-agent, merged). |
| 2026-10-08 | S-019 | todo → done | `exploreStep`, `EngineContext`, JSONL trace writer + `TraceLineSchema` (sub-agent, merged). |
| 2026-10-08 | S-021 | todo → done | Deterministic assertions `runAssertion`, `StepCapture` (sub-agent, merged). |
| 2026-10-08 | S-018 | todo → done | Guards: domain, read-only, sensitive-action classifier, loop, untrusted-text wrapper (sub-agent, merged). |
| 2026-10-08 | S-016 | todo → done | `resolveInput` text-input resolution + literal store (sub-agent, merged). |
| 2026-10-08 | S-014 | todo → done | Coarse-to-fine `narrow` (sub-agent, merged). |
| 2026-10-08 | S-015 | todo → done | Executor `execute()`, `inferAction`, stability waits (sub-agent, merged). |
| 2026-10-08 | S-013 | todo → done | Page context, action history, Set-of-Marks, `serializeObservation`, fingerprint (sub-agent, merged). |
| 2026-10-07 | S-012 | todo → done | Observer: `captureElements`, locators, `ElementMap` (sub-agent, reviewed + merged). |
| 2026-10-07 | S-017 | todo → done | Gate, dual-order, human hook (sub-agent, reviewed + fixed). |
| 2026-10-07 | S-011 | todo → done | Provider probe + `s1pilot probe` CLI. |
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
| S-011 | Provider probe & auto-detect | P1 | done | build/typecheck/lint/test green (providers 174, cli 8 tests). Added domain `ProbeResultSchema`; `probe()` in providers; `s1pilot probe` in cli (`--url --model --key --adapter --json`, key also via `S1PILOT_API_KEY`). Detection exercises the **assumed** systemone/decide wire formats against fake servers only — try it against a real model. Unreachable URL → `ok:false` in ~60 ms (timeouts cap at one request timeout, default 5 s). |
| S-012 | Observer: elements & locators | P1 | done | Built by a sub-agent in a worktree, diff merged into main and re-verified; build/typecheck/lint/test green (engine 49 tests incl. 8 fixture-site snapshots). **Deviations:** Playwright 1.63 has no `page.accessibility`, so role/accessible name are computed in-page (one `evaluate` per frame, reaches shadow DOM); no separate "in viewport" filter (non-zero box only); `ObservedElement.frame` added; shadow content ordered right after its host. Perf test asserts best-of-5 after warm-up < 500 ms (lenient). New engine deps: `playwright`; dev: `@playwright/test`, `@s1pilot/fixture-sites`. `Observation` type left for S-013 (`ElementMap`/`indexElements` provided). |
| S-013 | Observer: page context & Set-of-Marks | P1 | done | Sub-agent, merged; engine tests green. Fingerprint also hashes interactive element role+name (else the renamed-button variant wouldn't change it). SoM downscale via canvas on a scratch page (no `sharp`). |
| S-014 | Coarse-to-fine narrowing | P1 | done | Sub-agent, merged. Code in `engine/src/narrow/`. Candidates capped at `maxOptions - 5` (room for meta actions). Tests use synthetic observations, not a browser. |
| S-015 | Executor | P1 | done | Sub-agent, merged; 12 new tests. `execute()` never throws; only uniquely-resolving candidates used, at most 2 tried. `EngineAction` lives in engine. Popup/dialog/download tests use `setContent` (fixture sites have none). |
| S-016 | Text input resolution | P1 | done | Sub-agent, merged. Code in `engine/src/text-input/` (not `decide/`). Only key names reach S1/S2; password-like fields never go to S2. Extra exports `createLiteralStore`, `createValueResolver`. |
| S-017 | Gate, escalation & dual-order | P1 | done | Built by a sub-agent in a worktree, diff applied to main and re-verified; build/typecheck/lint/test green (engine 34 tests). I fixed a prototype-key bug (`in` → `Object.hasOwn` for option ids; regression tests added). `GateResult` is a union on `outcome` (act/blocked/skip/abort/takeover), each with a `DecisionRecord`; `gate()` takes a `disagreement` flag from `decideDualOrder`. Human hook signals "no human" by throwing `HUMAN_UNAVAILABLE`. New dep: `@s1pilot/providers` in engine. |
| S-018 | Guards | P1 | done | Sub-agent, merged. `classifySensitive` returns `SensitiveClass` (name `SensitiveAction` taken by the gate). Read-only guard blocks all non-GET/HEAD/OPTIONS requests. Not yet wired into the executor (S-019). |
| S-019 | Explore step loop & trace | P1 | done | Sub-agent, merged; engine 129 tests. `TraceLineSchema` lives in engine (`trace/schema.ts`). New engine dep: `zod`. `passed` means the action was performed; expected-result checks are S-020/S-021. Step guards come in via `ExploreStepInput.guards`. SoM screenshot not captured in the loop. |
| S-020 | Verifier: AI-judged assertions & verdict policy | P1 | done | Sub-agent, merged; engine 154 tests. Dual-phrasing for `noul` is done in `ai.ts` (`decideDualOrder` only reorders `choice`). `VerifiedAssertion` is engine-level (domain `AssertionVerdict` has no model field; model id also on `DecisionRecord`). `verdictFor` takes an extra `dualOrderAgreed`; disagreement → needs-review. Step with no assertions/expected text → passed. |
| S-021 | Deterministic assertions | P1 | done | Sub-agent, merged. Code in `engine/src/verify/`. Field names follow the S-002 `AssertionSchema`, which differs from the spec prose (no `matches`/JSON path). `ai` assertions fail here; S-020 owns them. |
| S-022 | YAML case loader & CLI `run` | P1 | done | Sub-agent, merged; cli 15 + sync 9 tests. Exit codes 0 passed / 1 failed or blocked / 2 needs-review only / 3 config error. `--mock-script` JSON format is our own (`steps`, `inputs`, `expected`). Added `--base-url`, `--profile`, `--key`, `--project`. CLI resolves only `env:NAME` secret refs (vault refs out of scope); inline secrets in YAML rejected. `flow:`/`auth:` preconditions not applied in explore mode (`TODO(S-026)`); YAML step schema has no per-step `guards`. `.gitignore` exception tracks the secret-free fixture project `fixtures/sites/.s1pilot/`. The ≥70% real-model step success rate was **not** measured (manual check). |
| S-023 | Learned script capture | P2 | done | Sub-agent, merged. `LearnedRecorder`/`buildLearnedScript` (engine), `FsLearnedScriptStore` + DB-backed store; CLI saves script after a passing run (single-row cases only). Added optional `postFingerprint`/`waitHint`/`stepHash` to `ResolvedAction`. Step hash covers raw text with `{placeholders}` (param change doesn't invalidate; revisit in S-024/S-026). |
| S-024 | Replay mode | P2 | done | Sub-agent, merged. `replayStep`, `chooseMode`, tolerant `fingerprintsMatch` (page fingerprint format changed; old scripts re-explore). Replay drops CSS locators when a semantic one exists. Not wired into CLI/runner (S-027). `StepResult.mode` in schema, not persisted yet. Replay/chooseMode should receive the instance's bound steps. |
| S-025 | Heal mode & heal proposals | P2 | done | Sub-agent, merged (fast-forward). `healStep`, `replayWithHeal` (engine); `HealProposal` replaced with spec shape + new `heal_proposals` table (migration 0001) and `healProposals` repo (create/list/approve/reject, scope all/case); project setting `autoApplyHeals` (default false; not synced yet). Engine returns drafts, persisting is S-027's job. No heal below `act` confidence. |
| S-026 | Parameters & shared steps | P2 | done | Sub-agent, merged. `expandCase`, shared-step inlining, preconditions (failure ⇒ case `blocked`), flow/dataset loaders (`@s1pilot/sync`), `scriptKey` per instance. Auth preconditions print "not applied yet" (`TODO(S-038)`). Mock script counts calls per step text across the run, so row step texts must differ in tests. |
| S-027 | Case runner & JUnit/JSON reporters | P2 | done | Sub-agent, merged (fast-forward). `runCases` (runner), JUnit/JSON reporters + `validateJunit` (own structural validator; no XSD tool), `RunReportSchema` (domain), CLI `run --mode replay-heal|explore|replay-only --reporter junit,json --parallel n` (default mode replay-heal). Mock-script moved to providers. Heal proposals: DB if `.s1pilot/data.db` exists, else `.s1pilot/heal-proposals/<id>.json`; approving in DB doesn't update FS scripts (S-034). Auth hook unused (`TODO(S-038)`). `FsLearnedScriptStore.get` sets env id (fixes environment-mismatch). |
| S-028 | HTML report | P2 | done | Sub-agent, merged. `renderHtml` + `--reporter html` (self-contained, no network by default, redacted, screenshots inlined up to 15 MB). Screenshots found by convention `<case.dir>/step-<n>*.png` — verify against runner naming; report has no "Expected" field yet. |
| S-029 | Tests-as-code sync | P2 | done | Sub-agent, merged. `exportProject`/`importProject`/`syncStatus` (sync), `s1pilot sync` CLI (`--db --dry-run --prune --json`), `cases.createWithKey` (db). Secrets never exported; plaintext secret in file ⇒ `SECRET_IN_FILE`. `data/*` not synced; conflicts detected for cases only. sync and cli now depend on db. |
| S-030 | Eval harness & seeded bugs | P2 | done | Sub-agent, merged. `s1pilot eval --suite … [--models --oracle --repeat --out]`; metrics + leaderboard + engine sha; `--oracle` uses mock scripts (100% detection, 0 false-pass in test). Suite `suites/fixtures-all` has only SHOP-TC-42 (clean + `badge-wrong-count`); other fixture cases need YAML + mock scripts. Fixture server must be running (not auto-started). Added `yaml` dep to cli. **P2 complete.** |
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
