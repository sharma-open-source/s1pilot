# Getting started: your first test in 5 minutes

This walks through the same flow the automated E2E (`e2e/first-test.spec.ts`) runs on every build: create a project,
connect a decision model, describe a test in plain language, let the AI explore it once (with you approving what it is
unsure about), then run it again and watch it **replay** deterministically.

> **Just want to see it work?** `s1pilot demo` starts the demo shop, a scripted model and the app with a ready test.
> No API key and no repository checkout needed. This guide is the longer path with your own model.

## 1. Prerequisites

- Node.js 22.12 or newer.
- A System 1 decision model endpoint (Clef, Laya, Jev, ...). A local or LAN endpoint keeps page data on your network.
  The fastest option is Clef on OpenRouter; see
  [Getting a model](https://github.com/sharma-open-source/s1pilot#getting-a-model) in the README.
- A web app to test. This guide uses the bundled demo shop (`fixtures/sites`) on `http://127.0.0.1:4400/shop`.

## 2. Start the app

Install the published package:

```bash
npm install -g s1pilot
npx playwright install chromium               # once: the browser the runs use
s1pilot ui
```

For the demo shop used below, you also need a checkout of this repository. Build it and start the fixture sites:

```bash
pnpm install
pnpm build
npx playwright install chromium               # once: the browser the runs use
pnpm --filter @s1pilot/fixture-sites dev &    # demo sites on http://127.0.0.1:4400 (stop it afterwards)
node apps/cli/dist/index.js ui
```

Or from a packed CLI tarball (the web app is bundled inside it):

```bash
(cd apps/cli && pnpm pack --pack-destination /tmp/s1pilot-pack)
mkdir /tmp/s1pilot-try && cd /tmp/s1pilot-try && npm init -y
npm install /tmp/s1pilot-pack/s1pilot-*.tgz
npx playwright install chromium
npx s1pilot ui
```

`s1pilot ui` starts the API, the run workers and the web app in one process and opens
`http://127.0.0.1:5317`. Options:

| Option | Meaning |
|---|---|
| `--port <n>` | Port to listen on (default `5317`). |
| `--data-dir <dir>` | Where the database, artifacts and the encryption key live (default `./.s1pilot` if it exists, else `~/.s1pilot`). |
| `--no-open` | Do not open a browser window (use this on servers and in CI). |
| `--workers <n>` | How many test cases can run at once, each in its own browser (1–32). A plan's "Parallel workers" can only lower this. Default: `S1PILOT_WORKERS`, else 1. |

Press `Ctrl+C` to stop it.

## 3. Create the project

1. **Basics.** Name `Fixture Shop`, key `SHOP`, base URL `http://127.0.0.1:4400/shop`. Continue.
2. **Environments.** Keep the `dev` environment. Continue.
3. **Models.** Under *System 1 · decision model* enter your endpoint's base URL (and model name), then press
   **Test connection**. The adapter is detected and the capability grid is filled in. Continue.
4. **Login setup.** Not needed for the demo shop: **Skip**.

## 4. Write the test and run it with AI

On **First tests**, describe what a user should be able to do. Include the action that moves the flow on, because steps
are followed literally:

> Add the Classic Tee in Blue, size M, to the cart and check the cart badge shows 1

Press **Run now (explore)**. You land on the live run screen: the steps on the left, the browser screencast with
numbered element boxes in the middle, and System 1's decision (options with probabilities) on the right.

The run is *attended*. When System 1 is not confident enough to act, the run pauses and the decision panel shows
**Approve ...** for its best guess (or pick another option). Approve it and the run continues. Without a person
watching, an unsure step is blocked instead of guessed.

When the run finishes as **passed**, the steps System 1 resolved are saved as a **learned script** for the `dev`
environment.

## 5. Check the learned script and run again

Open **Test cases**, open `SHOP-TC-1` and choose the **Learned script** tab: it shows *Ready · 1/1 steps*.

Press **Run now** on the case. This time the default mode (*replay first, heal with S1*) replays the learned script
without a single model call. Open the run report: the step reads `✓ replay`. If the page changes later, only the broken
step is healed with System 1 and the change is proposed for your approval.

## 6. Clean up

Stop `s1pilot ui` with `Ctrl+C` and stop the fixture server (`kill %1` or end its terminal). Your data stays in the data
directory; delete it to start over.

## Notes

- Page text and screenshots are sent to the System 1 endpoint according to **Data sent to models** in the Models step.
  Secrets are referenced as `env:NAME`, `var:key` or `secret:key` and never sent to a model.
- Playwright traces (`trace.zip`) contain DOM snapshots that are not secret-masked yet. Do not share them from runs that
  type secrets.
- To check the whole flow without a real model, run the E2E: `pnpm --filter @s1pilot/e2e test`. It starts the built
  app, the fixture shop and a fake System 1 server answering from an oracle script.
