# Contributing to s1pilot

Thanks for helping. Bug reports, fixture sites with seeded bugs, model profiles and fixes are all welcome.

## Set up

Node.js 22.12 or newer and pnpm 9 (`corepack enable`).

```bash
pnpm install
pnpm --filter @s1pilot/fixture-sites exec playwright install chromium
pnpm build
pnpm lint && pnpm typecheck && pnpm test
```

Run the app from the checkout with `node apps/cli/dist/index.js ui`, or `node apps/cli/dist/index.js demo` for the
no-key demo. Run the end-to-end test, which needs no real
model, with `pnpm --filter @s1pilot/e2e test`.

## Finding something to work on

Look at the
[good first issues](https://github.com/sharma-open-source/s1pilot/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
and [help wanted](https://github.com/sharma-open-source/s1pilot/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)
issues, or the roadmap in [docs/plan.md §15](docs/plan.md#15-roadmap). For anything bigger than a fix, open an issue or
a [discussion](https://github.com/sharma-open-source/s1pilot/discussions) first so we can agree on the approach. Fixture
sites with seeded bugs and model profiles are good self-contained contributions.

## Ground rules

- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- [AGENTS.md](AGENTS.md) holds the coding conventions, repository layout and security rules. They apply to people too.
- Tests never call real model endpoints or external services. Use the `mock` adapter or recorded fixtures.
- Never commit `.env`, `.s1pilot/` data directories, keys or recorded storage states.
- UI changes follow [docs/design.md](docs/design.md) and the wireframes in [docs/wireframes/](docs/wireframes/).

## Pull requests

Keep each pull request focused and include tests for new logic. CI must be green: lint, typecheck, tests, build and the
Postgres job.

By contributing, you agree that your contribution is licensed under the [Apache-2.0 license](LICENSE).
