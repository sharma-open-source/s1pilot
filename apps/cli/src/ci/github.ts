import { PR_COMMENT_MARKER } from './summary.js';

/** Where to post: repository `owner/name` and pull request number. */
export interface PrTarget {
  repo: string;
  pullNumber: number;
  /** GitHub API base, default `https://api.github.com` (GitHub Enterprise: `$GITHUB_API_URL`). */
  apiUrl?: string;
  /** `GITHUB_TOKEN`; sent as a bearer token, never logged. */
  token: string;
}

interface GhComment {
  id: number;
  body?: string;
}

async function gh<T>(fetchImpl: typeof fetch, target: PrTarget, method: string, path: string, body?: unknown): Promise<T> {
  const base = (target.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const res = await fetchImpl(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${target.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 's1pilot-cli',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`GitHub API ${method} ${path} failed with ${res.status}`);
  return (await res.json()) as T;
}

/** Creates the s1pilot PR comment, or updates the existing one (found by its marker). */
export async function upsertPrComment(
  target: PrTarget,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: number; created: boolean }> {
  const base = `/repos/${target.repo}`;
  for (let page = 1; page <= 10; page += 1) {
    const comments = await gh<GhComment[]>(fetchImpl, target, 'GET', `${base}/issues/${target.pullNumber}/comments?per_page=100&page=${page}`);
    const existing = comments.find((c) => c.body?.includes(PR_COMMENT_MARKER));
    if (existing) {
      await gh(fetchImpl, target, 'PATCH', `${base}/issues/comments/${existing.id}`, { body });
      return { id: existing.id, created: false };
    }
    if (comments.length < 100) break;
  }
  const created = await gh<GhComment>(fetchImpl, target, 'POST', `${base}/issues/${target.pullNumber}/comments`, { body });
  return { id: created.id, created: true };
}
