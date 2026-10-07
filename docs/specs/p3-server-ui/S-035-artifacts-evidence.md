# S-035 · Artifact store & evidence capture

**Phase:** P3 · **Depends on:** S-034 · **Packages:** `@s1pilot/runner`, `apps/server` · **Plan refs:** §2.7, §9 Artifact store, §13 retention

## Goal
Screenshots, video, Playwright traces, console/network logs and decision traces are stored per result and served to the UI.

## Scope
- `ArtifactStore` interface (`put(stream|buffer, meta) → artifactId`, `get(id) → stream`, `delete`, `purge(olderThan, projectId)`) + `FsArtifactStore` under `artifactsDir/<project>/<run>/<result>/`.
- Capture in runner: screenshot after each step (PNG, with secret masking: elements whose value is a secret ref get `mask` in `page.screenshot({ mask })`), video per case (`recordVideo`, plan setting), Playwright trace (`context.tracing` with screenshots+snapshots), console messages, network log (HAR-lite JSON: url, method, status, timing), trace.jsonl.
- `Evidence` rows linked to `StepResult`/`CaseResult`.
- REST `GET /api/artifacts/:id` (content-type, range requests for video), `GET /api/artifacts/:id/trace-viewer` redirect/instructions (`npx playwright show-trace` link + bundled trace viewer static if feasible).
- Retention job: daily purge per project `retentionDays`.

## Acceptance criteria
- [ ] A run produces per-step screenshots and a downloadable trace zip.
- [ ] Secret field masked in screenshot (pixel check: masked box colour).
- [ ] Video served with HTTP range support.
- [ ] Purge removes files and rows older than retention.

## Tests
- Store unit tests; integration via run.

## Out of scope
- S3 (S-068), a11y artifacts (S-053).
