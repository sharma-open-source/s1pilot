# S-068 · Remote workers & S3 artifacts

**Phase:** P7 · **Depends on:** S-066 · **Packages:** `@s1pilot/runner`, `apps/server`, `apps/cli` · **Plan refs:** §9 (workers on other machines), §10 Artifacts, Packaging

## Goal
Workers run on other machines (e.g. next to the GPU model server) and artifacts live in S3-compatible storage.

## Scope
- `s1pilot worker --server URL --token T [--concurrency n] [--labels gpu,eu]`: registers with server (heartbeat), pulls jobs from the queue via server API (or direct pg-boss when DB reachable), streams events/screencast to server over WS, uploads artifacts.
- Job routing by labels (plan setting "run on workers with label").
- `S3ArtifactStore implements ArtifactStore` (`@aws-sdk/client-s3`, MinIO compatible, presigned GET URLs for UI).
- Settings › Workers shows remote workers (labels, version, status, current job, last heartbeat).
- Docker images: `s1pilot/server`, `s1pilot/worker` (Playwright base image) with GitHub Actions publish workflow.

## Acceptance criteria
- [ ] Compose stack with 1 server + 2 workers + MinIO runs a plan; artifacts served via presigned URLs.
- [ ] Worker disconnect → its leased jobs requeued after lease expiry.
- [ ] Label routing sends GPU-labelled plan jobs only to labelled workers.

## Tests
- Compose-based integration test (CI nightly).

## Out of scope
- Autoscaling workers.
