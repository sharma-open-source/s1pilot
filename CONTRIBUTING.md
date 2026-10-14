# Contributing to s1pilot

Thanks for helping. Bug reports, fixture sites with seeded bugs, model profiles and fixes are all welcome.

## Set up

Node.js 20 or newer and pnpm 9 (`corepack enable`).

```bash
pnpm install
pnpm --filter @s1pilot/fixture-sites exec playwright install chromium
pnpm build
pnpm lint && pnpm typecheck && pnpm test
```

Run the app from the checkout with `node apps/cli/dist/index.js ui`. Run the end-to-end test, which needs no real
model, with `pnpm --filter @s1pilot/e2e test`.

## Ground rules

- [AGENTS.md](AGENTS.md) holds the coding conventions, repository layout and security rules. They apply to people too.
- Tests never call real model endpoints or external services. Use the `mock` adapter or recorded fixtures.
- Never commit `.env`, `.s1pilot/` data directories, keys or recorded storage states.
- UI changes follow [docs/design.md](docs/design.md) and the wireframes in [docs/wireframes/](docs/wireframes/).

## Pull requests

Keep each pull request focused and include tests for new logic. CI must be green: lint, typecheck, tests, build and the
Postgres job.

By contributing, you agree that your contribution is licensed under the [Apache-2.0 license](LICENSE).
