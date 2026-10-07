# S-001 · Monorepo scaffold

**Phase:** P0 · **Depends on:** — · **Packages:** repo root, all package skeletons · **Plan refs:** §10, §11

## Goal
A buildable, lintable, testable empty monorepo with every package and app from plan §11 present as a skeleton, so later specs only add code.

## Scope
- Root: `package.json` (private, `packageManager: pnpm@9`), `pnpm-workspace.yaml`, `turbo.json` (pipelines `build`, `typecheck`, `lint`, `test`, `dev`), `tsconfig.base.json` (strict, `moduleResolution: bundler`, `target: ES2022`, ESM), `.editorconfig`, `.gitignore`, `.nvmrc` (20), `.prettierrc`, ESLint flat config (`typescript-eslint` strict, `eslint-plugin-import` ordering), `vitest.workspace.ts`.
- Package skeletons, each with `package.json` (`"type":"module"`, `exports`, `scripts: build/typecheck/lint/test`), `tsconfig.json`, `src/index.ts`, one trivial passing test:
  - `packages/domain`, `packages/db`, `packages/providers`, `packages/engine`, `packages/runner`, `packages/reporters`, `packages/integrations`, `packages/sync`
- App skeletons: `apps/server` (Node entry printing version), `apps/cli` (bin `s1pilot`, `commander`, `--version` only), `apps/web` (leave empty folder with README — S-039 scaffolds it).
- Folders: `profiles/`, `fixtures/sites/`, `suites/`, `docs/` (keep existing docs).
- Build with `tsup` for packages and cli (ESM + d.ts).
- Root scripts: `pnpm build | typecheck | lint | test | format`.
- GitHub Actions workflow `.github/workflows/ci.yml`: install, `pnpm lint typecheck test build` on Node 20.

## Interfaces
- Package names: `@s1pilot/domain`, `@s1pilot/db`, `@s1pilot/providers`, `@s1pilot/engine`, `@s1pilot/runner`, `@s1pilot/reporters`, `@s1pilot/integrations`, `@s1pilot/sync`, apps `@s1pilot/server`, `@s1pilot/cli`, `@s1pilot/web`.
- Internal deps use `workspace:*`.

## Acceptance criteria
- [ ] `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test` succeed from a clean clone.
- [ ] `node apps/cli/dist/index.js --version` prints the version from root `package.json`.
- [ ] Importing `@s1pilot/domain` from `@s1pilot/engine` typechecks (workspace linking works).
- [ ] CI workflow file is valid YAML and runs the same commands.

## Tests
- One `index.test.ts` per package asserting the module loads.

## Out of scope
- Any domain logic (S-002+), web app scaffolding (S-039), Docker images (S-068).
