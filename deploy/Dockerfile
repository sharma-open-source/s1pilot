# Images of the s1pilot server and the remote worker (team mode). Build context: the repository root.
#
#   docker build -f deploy/Dockerfile --target server -t s1pilot/server .
#   docker build -f deploy/Dockerfile --target worker -t s1pilot/worker .
#
# Both are built on the Playwright base image: Chromium (and Firefox / WebKit) with their system libraries are
# preinstalled, Node 22 (required by pg-boss). The server needs a browser for PDF export and the recorder; the worker
# for running tests.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS build

# Native modules (better-sqlite3, argon2) compile with node-gyp at install time: it needs make and a C++ compiler.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
ENV NODE_ENV=production

# s1pilot/server: API, web app, scheduler and (optionally) in-process workers.
FROM build AS server
WORKDIR /app/apps/server
EXPOSE 5317
ENTRYPOINT ["node", "dist/main.js"]

# s1pilot/worker: `s1pilot worker`, configured with S1PILOT_SERVER_URL, S1PILOT_WORKER_TOKEN and S1PILOT_WORKER_LABELS.
FROM build AS worker
WORKDIR /app/apps/cli
ENTRYPOINT ["node", "dist/index.js", "worker"]
