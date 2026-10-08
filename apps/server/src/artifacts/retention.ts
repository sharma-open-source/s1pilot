import { repos, type Db } from '@s1pilot/db';
import type { FastifyBaseLogger } from 'fastify';

import type { ArtifactStore } from './store.js';

const DAY_MS = 86_400_000;

/**
 * Purges artifacts (files, metadata, evidence rows) older than each project's `retentionDays`.
 * Returns the number of artifacts removed per project key (projects with nothing removed are left out).
 */
export async function runRetention(
  db: Db,
  store: ArtifactStore,
  now: Date = new Date(),
): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const project of await repos.projects.list(db)) {
    const n = await store.purge(
      new Date(now.getTime() - project.retentionDays * DAY_MS),
      project.id,
    );
    if (n > 0) removed[project.key] = n;
  }
  return removed;
}

/**
 * Starts the daily retention job (first pass one minute after start). Returns a function that stops it.
 */
export function startRetentionJob(opts: {
  db: Db;
  store: ArtifactStore;
  log: FastifyBaseLogger;
  intervalMs?: number;
  firstRunMs?: number;
}): () => void {
  const pass = (): void => {
    runRetention(opts.db, opts.store).then(
      (removed) => {
        if (Object.keys(removed).length > 0) opts.log.info({ removed }, 'artifact retention purge');
      },
      (error) => opts.log.error({ err: error }, 'artifact retention failed'),
    );
  };
  const first = setTimeout(pass, opts.firstRunMs ?? 60_000);
  const timer = setInterval(pass, opts.intervalMs ?? DAY_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
