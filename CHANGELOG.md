# Changelog

All notable changes to s1pilot are listed here. This project follows [Semantic Versioning](https://semver.org/).

## 0.2.0 (unreleased)

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
