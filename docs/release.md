# Releasing s1pilot

## One-time setup

1. **npm.** Create an npm account with 2FA and an *automation* token. Add the token as the repository secret
   `NPM_TOKEN`. After the first publish, you can replace the token with npm trusted publishing for `release.yml`.
2. **GitHub Pages.** Go to Settings > Pages > Source and choose *GitHub Actions*. Pages on a free plan needs a public
   repository.
3. **Repository settings.** Set the description and website (`https://sharma-open-source.github.io/s1pilot/`), and add
   topics such as `testing`, `playwright`, `ai` and `e2e`. Enable private vulnerability reporting under
   Security > Advisories.
4. **Container images.** After the first `docker-publish.yml` run, make the `s1pilot/server` and `s1pilot/worker`
   packages public under the organisation's Packages tab.

## Each release

1. Make sure `master` is green in CI.
2. Set the version in `apps/cli/package.json` and move the `CHANGELOG.md` entry from *unreleased* to the release date.
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

Target length is 90 to 120 seconds at 1920×1080, with captions burned in rather than a voice-over. Also export a
1280×720 PNG frame as `site/assets/demo-poster.png`. That image is used as the video poster and the social preview.
Keep the MP4 under 25 MB (H.264, `-crf 28`).

Record against the fixture shop with a real model, in a fresh data directory, so no personal data appears on screen.

| # | Shot | Caption |
|---|---|---|
| 1 | Terminal: `npm i -g s1pilot && s1pilot ui`, and the browser opens | One command starts the app |
| 2 | Project wizard: name, base URL, model URL, **Test connection** shows the capability grid | Bring your own decision model |
| 3 | First tests: type the Classic Tee sentence, then press **Run now (explore)** | Describe the test in plain language |
| 4 | Live run: screencast with element boxes, and the decision panel with probabilities | System 1 picks each action, with a probability |
| 5 | The run pauses on an unsure step, and you press **Approve** | Unsure? It asks instead of guessing |
| 6 | Passed. **Learned script** tab: *Ready* | A passing run becomes a learned script |
| 7 | **Run now** again: every step shows `✓ replay`, with the duration next to it | Replay: no model calls |
| 8 | Run with `?bugs=shop.badge-wrong-count`: it fails at step 2 with the expected and actual values | Catches real bugs |
| 9 | Terminal: `s1pilot run … --reporter junit,html`, exit code, HTML report | Same tests in CI |
| 10 | End card: `npm i -g s1pilot` and the GitHub URL | |

Before publishing, check every frame for API keys, tokens and personal data.
