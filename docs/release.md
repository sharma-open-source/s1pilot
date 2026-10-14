# Releasing s1pilot

## One-time setup

1. **npm (trusted publishing, no token).** npm can only attach a trusted publisher to a package that already exists,
   so the first version is published by hand once:
   ```bash
   npm login                                   # account with 2FA
   pnpm build && (cd apps/cli && pnpm pack --pack-destination /tmp/s1pilot-pack)
   npm publish /tmp/s1pilot-pack/s1pilot-0.2.0.tgz --access public
   ```
   Then on npmjs.com, go to s1pilot > Settings > Trusted publisher and choose *GitHub Actions*: organisation
   `sharma-open-source`, repository `s1pilot`, workflow `release.yml` (no environment). Under *Publishing access*,
   choose "Require two-factor authentication and disallow tokens". Every later version is published by `release.yml`
   over OIDC with automatic provenance, and the workflow skips the npm step for a version that is already published.
   Trusted publishing with provenance needs the GitHub repository to be public.
2. **GitHub Pages.** Go to Settings > Pages > Source and choose *GitHub Actions*. Pages on a free plan needs a public
   repository.
3. **Repository settings.** Set the description and website (`https://sharma-open-source.github.io/s1pilot/`), and add
   topics such as `testing`, `playwright`, `ai` and `e2e`. Enable private vulnerability reporting under
   Security > Advisories.
4. **Container images.** After the first `docker-publish.yml` run, make the `s1pilot/server` and `s1pilot/worker`
   packages public under the organisation's Packages tab.

## Each release

1. Make sure `master` is green in CI.
2. Run `pnpm release:version <x.y.z>`. It sets the version in both `package.json` and `apps/cli/package.json`, which must
   match. Then add the `CHANGELOG.md` entry with the release date.
3. Smoke-test the packed package outside the repository:
   ```bash
   pnpm build
   (cd apps/cli && pnpm pack --pack-destination /tmp/s1pilot-pack)
   mkdir -p /tmp/s1pilot-try && cd /tmp/s1pilot-try && npm init -y >/dev/null
   npm install /tmp/s1pilot-pack/s1pilot-<version>.tgz
   npx playwright install chromium && npx s1pilot --version && npx s1pilot ui
   ```
4. Run the real-model smoke test from `AGENTS.md`. Expect the clean run to pass 4/4 and the seeded-bug run to fail at
   step 2.
5. Commit, then tag and push:
   ```bash
   git tag v<version> && git push origin master v<version>
   ```
   `release.yml` runs the checks, publishes to npm with provenance and creates the GitHub release.
   `docker-publish.yml` pushes the images.
6. Check <https://www.npmjs.com/package/s1pilot> and run `npx s1pilot@<version> --version`.

## Demo video (`site/assets/demo.mp4`)

The video and its poster (`site/assets/demo-poster.png`, also the social preview) are recorded by a script that drives
the real app against a **real** System 1 model and the public practice site
[PlayLab](https://playwrightlab.github.io/login.html). It covers the wizard, Test connection, a draft test, the
`email` variable and the encrypted `password` secret, an AI exploration, the learned script, and a replay with no
model calls. Re-record it when the UI changes visibly:

```bash
set -a; . ./.env; set +a                       # S1PILOT_API_KEY, never echoed
pnpm build
S1PILOT_DEMO_MODEL_URL=https://api.typesafe.ai/v1/systemone S1PILOT_DEMO_MODEL=jev-latest \
  node e2e/record-demo.mjs                     # needs ffmpeg; writes site/assets/
```

It uses a fresh temporary data directory and gives the UI only `env:S1PILOT_API_KEY`, so the key never appears on
screen. The model may escalate a step on another day; the script approves each escalation. Another site:
`S1PILOT_DEMO_BASE_URL` (the script's test step and test data are written for the PlayLab login).
Watch the result before committing.
