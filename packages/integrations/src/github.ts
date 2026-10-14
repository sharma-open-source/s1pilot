import { S1PilotError, type DefectStatus } from '@s1pilot/domain';

import { failure, requestJson, trimUrl } from './http.js';
import { buildSections, toMarkdown } from './render.js';
import type {
  ConnectionResult,
  CreatedIssue,
  ExternalStatus,
  FetchLike,
  IssueTracker,
  TrackerAttachment,
  TrackerCredentials,
  TrackerDefect,
  TrackerMapping,
  TrackerOptions,
} from './types.js';

/**
 * GitHub Issues (REST). The API has no attachment upload, so attachments are listed by file name in the body
 * and stay in s1pilot.
 */
export class GithubTracker implements IssueTracker {
  readonly provider = 'github' as const;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    creds: TrackerCredentials,
    private readonly mapping: TrackerMapping = {},
    opts: TrackerOptions = {},
  ) {
    this.base = trimUrl(creds.baseUrl || 'https://api.github.com');
    this.token = creds.token;
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  private json<T>(path: string, what: string, method = 'GET', body?: unknown): Promise<T> {
    return requestJson<T>(
      this.fetchImpl,
      `${this.base}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      what,
    );
  }

  private repo(): string {
    const repo = this.mapping.githubRepo;
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new S1PilotError('TRACKER_CONFIG', 'No GitHub repository (owner/name) is mapped for this project');
    return repo;
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      const me = await this.json<{ login?: string }>('/user', 'GitHub sign-in');
      if (this.mapping.githubRepo) await this.json(`/repos/${this.repo()}`, `GitHub repository ${this.mapping.githubRepo}`);
      return { ok: true, detail: `Signed in as ${me.login ?? 'unknown user'}` };
    } catch (error) {
      return failure(error);
    }
  }

  async createIssue(defect: TrackerDefect, attachments: TrackerAttachment[]): Promise<CreatedIssue> {
    const repo = this.repo();
    const names = attachments.map((a) => `${a.filename} (kept in s1pilot)`);
    const issue = await this.json<{ number: number; html_url: string }>(`/repos/${repo}/issues`, 'GitHub create issue', 'POST', {
      title: defect.title.slice(0, 250),
      body: toMarkdown(buildSections(defect, names)),
      labels: ['s1pilot', 'bug', `severity-${defect.severity}`, ...(this.mapping.githubLabels ?? [])],
    });
    return { id: String(issue.number), url: issue.html_url };
  }

  async getStatus(externalId: string): Promise<ExternalStatus> {
    const issue = await this.json<{ state: string; state_reason?: string | null }>(
      `/repos/${this.repo()}/issues/${encodeURIComponent(externalId)}`,
      'GitHub get issue',
    );
    return { name: issue.state, state: issue.state === 'closed' && issue.state_reason === 'not_planned' ? 'closed:not_planned' : issue.state };
  }

  /** open -> open, closed -> fixed, closed as "not planned" -> closed. */
  mapStatus(external: ExternalStatus): DefectStatus {
    if (external.state === 'closed:not_planned') return 'closed';
    if (external.state === 'closed') return 'fixed';
    return 'open';
  }

  async addComment(externalId: string, body: string): Promise<void> {
    await this.json(`/repos/${this.repo()}/issues/${encodeURIComponent(externalId)}/comments`, 'GitHub add comment', 'POST', { body });
  }
}
