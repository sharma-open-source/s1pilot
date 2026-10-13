# Image of the s1-pilot server / worker (team mode). Build context: the repository root.
# Playwright base image: Chromium and its system libraries are preinstalled (Node 22, required by pg-boss).
FROM mcr.microsoft.com/playwright:v1.63.0-noble

RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

ENV NODE_ENV=production
WORKDIR /app/apps/server
ENTRYPOINT ["node", "dist/main.js"]
