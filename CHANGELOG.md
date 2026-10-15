# Changelog

All notable changes to s1pilot are listed here. This project follows [Semantic Versioning](https://semver.org/).

## Unreleased

- `s1pilot demo`: try s1pilot with no API key. Starts the bundled demo shop, a scripted stand-in model and the web app
  with a `DEMO` project and a ready test.
- README: "Getting a model", "How is this different?", and a clearer note on when replays call the model.

## 0.3.1 (2026-10-14)

- Security: nodemailer updated to 10.1.1.
- `pnpm release:version` script to set the version across all packages.

## 0.3.0 (2026-10-14)

- Package and docs renamed from s1-pilot to s1pilot.
- Requires Node.js 22.12 or newer.

## 0.2.0 (2026-10-14)

First public release.

- Local web app (`s1pilot ui`): projects, environments, suites, test cases, plans, live runs, review queue, defects,
  analytics and settings.
- Execution engine: System 1 decisions with probabilities, System 2 and human escalation, learned scripts with
  deterministic replay and healing (`replay-heal`, `explore`, `replay-only`).
- Model adapters: `systemone`, `decide`, `openai-logprobs`, `openai-chat` and `mock`, plus capability profiles for
  Clef, Laya and Jev.
- CLI: `run`, `probe`, `sync`, `eval`, `calibrate`, `worker`, `ci-comment` and `admin`. JUnit, JSON and HTML
  reporters.
- Tests as code: two-way YAML sync with the `.s1pilot/` folder.
- Team deployment: server and worker Docker images, Postgres job queue and S3 artifact storage.
