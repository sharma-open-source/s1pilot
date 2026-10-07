# S-002 · Domain schemas

**Phase:** P0 · **Depends on:** S-001 · **Packages:** `@s1pilot/domain` · **Plan refs:** §1, §1.1, §2.3, §2.4, §5

## Goal
All core entities and engine contracts exist as zod schemas + inferred types, shared by server, UI, CLI and engine.

## Scope
Files under `packages/domain/src/`:
- `ids.ts` — `newId()` (nanoid), key helpers: `caseKey(projectKey, n) → "SHOP-TC-42"`, `parseCaseKey`.
- `project.ts` — `Project` (id, name, key `/^[A-Z][A-Z0-9]{1,9}$/`, defaultEnvironmentId, modelSettings, retentionDays, dataPolicy).
- `model-settings.ts` — `ModelEndpoint` (adapter: `systemone|decide|openai-logprobs|openai-chat|mock`, baseUrl, model, apiKeyRef?, profileId?), `ModelSettings` (system1, system2?, thresholds {act, pass, fail, escalate}, dualOrderSensitive: boolean), `DataPolicy` (sendPageText, sendScreenshots: `never|ambiguous|always`, redactPatterns[]).
- `environment.ts` — `Environment` (name, baseUrl, variables: `Variable[]` {key, value?, secret: boolean, source: `inline|env`, envVar?}, allowDomains[], authSetupFlowId?, browsers: `BrowserTarget[]`, readOnly, requireApprovalFor: `SensitiveAction[]`, locale, timezone).
- `test-case.ts` — `TestCase`, `Step`, `Assertion` (discriminated union: `urlMatches`, `titleContains`, `elementVisible`, `elementText`, `elementValue`, `elementCount`, `responseStatus`, `noConsoleErrors`, `downloadExists`, `apiCheck`, `ai`), `Parameters`, `Precondition` (`{flow}` | `{auth}`), priority `P0–P3`, type `smoke|regression|e2e|exploratory`, status `draft|ready|deprecated`.
- `shared-step.ts` — `SharedStep` (id, name, params[], steps[]).
- `learned-script.ts` — `LearnedScript`, `ResolvedAction` (stepIndex, subIndex, action kind, `LocatorCandidate[]` {kind: `role|testId|text|css`, value, name?}, valueRef?, fingerprint, from runId), `health`.
- `plan.ts` — `TestPlan` (selection `{kind:'list', caseIds}` | `{kind:'query', query}`, matrix `{environmentId, browser, device?}[]`, retries, parallelism, mode `replay-heal|explore|replay-only`, unattended `block|pause`, schedule?, exitCriteria[], checks {a11y, consoleErrors, visual, video}).
- `run.ts` — `TestRun`, `CaseResult` (verdict `passed|failed|blocked|skipped|flaky|needs-review`, confidence, durationMs, mode `replay|healed|explore|manual`, escalations), `StepResult`, `DecisionRecord` (question id, options[], probabilities, chosen, confidence, model, latencyMs, escalatedTo?), `Evidence` (kind, artifactId).
- `defect.ts`, `requirement.ts`.
- `decision.ts` — `Question` and `DecisionModel` contract from plan §5 (types only; implementation S-006), `Capabilities`, `DecideRequest`, `DecideAnswer`.
- `events.ts` — `RunEvent` union used by WebSocket (S-036): `run.started`, `case.started`, `step.started`, `decision.made`, `assertion.verdict`, `escalation.needed`, `escalation.resolved`, `step.finished`, `case.finished`, `run.finished`, `log`.
- `errors.ts` (`S1PilotError`), `logger.ts` (pino factory with redaction hook).
- `index.ts` re-exports everything.

## Interfaces
- Every schema exported as `XSchema` with type `X = z.infer<typeof XSchema>`.
- YAML-facing shapes (`TestCaseFile`) mirror plan §1.2 exactly (`action`, `expected`, `assert`, `inputs`, `parameters`, `preconditions`).

## Acceptance criteria
- [ ] The YAML example in plan §1.2 parses (after `yaml` load) with `TestCaseFileSchema` without error.
- [ ] Invalid project keys, priorities and assertion types are rejected with readable zod messages.
- [ ] `RunEvent` is a discriminated union on `type`.
- [ ] No runtime deps except `zod`, `nanoid`, `pino`.

## Tests
- Round-trip parse tests for each entity with valid + invalid fixtures; the §1.2 YAML example as a fixture file.

## Out of scope
- Persistence (S-003), YAML file IO (S-022/S-029).
