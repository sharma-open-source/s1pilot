# S-063 · CI: CLI server mode & templates

**Phase:** P6 · **Depends on:** S-056, S-059 · **Packages:** `apps/cli`, `apps/server`, `docs/ci` · **Plan refs:** §12

## Goal
Run plans from CI either standalone or reporting to a server, with correct exit codes, reports and PR comments.

## Scope
- `s1pilot run --plan "<name>" --env <env> [--server URL --token T] [--build-ref --commit --branch] --reporter junit,html,json`:
  - with `--server`: creates the run remotely (`trigger: 'ci'`), streams progress lines via WS, downloads reports at the end; exit code from exit criteria (S-056).
  - standalone: loads `.s1pilot/` (S-029) and runs locally (as S-027).
- GitHub Actions: composite action `s1pilot/run-action` (`action.yml`) + example workflow; posts/updates a PR comment with summary table + report link (uses `GITHUB_TOKEN`).
- GitLab CI template `.gitlab/s1pilot.yml` with JUnit artifact upload.
- Settings › Integrations GitHub/GitLab cards: show connected when a token with `ci` usage has been used in last 30 days; "Configure" shows snippets.

## Acceptance criteria
- [ ] CLI against a test server returns exit 1 when criteria unmet, 0 otherwise.
- [ ] PR comment body rendered from template (unit test with fake GitHub API).
- [ ] Example workflow validated with `actionlint`.

## Tests
- CLI integration; template snapshot tests.

## Out of scope
- Other CI vendors (docs only).
