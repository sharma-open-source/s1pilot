import { S1PilotError, type DefectStatus } from '@s1pilot/domain';

import { failure, requestJson, trimUrl } from './http.js';
import { buildSections, toAdf } from './render.js';
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

/** Jira Cloud, REST v3, basic auth with account email + API token. */
export class JiraTracker implements IssueTracker {
  readonly provider = 'jira' as const;
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    creds: TrackerCredentials,
    private readonly mapping: TrackerMapping = {},
    opts: TrackerOptions = {},
  ) {
    if (!creds.baseUrl) throw new S1PilotError('TRACKER_CONFIG', 'Jira needs the site URL');
    if (!creds.email) throw new S1PilotError('TRACKER_CONFIG', 'Jira needs the account email');
    this.base = trimUrl(creds.baseUrl);
    this.auth = `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`;
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: this.auth, Accept: 'application/json', ...extra };
  }

  private json<T>(path: string, what: string, method = 'GET', body?: unknown): Promise<T> {
    return requestJson<T>(
      this.fetchImpl,
      `${this.base}${path}`,
      {
        method,
        headers: this.headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      what,
    );
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      const me = await this.json<{ displayName?: string }>('/rest/api/3/myself', 'Jira sign-in');
      if (this.mapping.jiraProject) {
        await this.json(`/rest/api/3/project/${encodeURIComponent(this.mapping.jiraProject)}`, `Jira project ${this.mapping.jiraProject}`);
      }
      return { ok: true, detail: `Signed in as ${me.displayName ?? 'unknown user'}` };
    } catch (error) {
      return failure(error);
    }
  }

  async createIssue(defect: TrackerDefect, attachments: TrackerAttachment[]): Promise<CreatedIssue> {
    const project = this.mapping.jiraProject;
    if (!project) throw new S1PilotError('TRACKER_CONFIG', 'No Jira project is mapped for this project');
    const created = await this.json<{ key: string }>('/rest/api/3/issue', 'Jira create issue', 'POST', {
      fields: {
        project: { key: project },
        issuetype: { name: this.mapping.jiraIssueType || 'Bug' },
        summary: defect.title.slice(0, 250),
        description: toAdf(buildSections(defect, attachments.map((a) => a.filename))),
        labels: ['s1pilot', `severity-${defect.severity}`],
      },
    });
    for (const a of attachments) {
      const form = new FormData();
      form.append('file', new Blob([a.data as unknown as ArrayBuffer], { type: a.contentType }), a.filename);
      await requestJson(
        this.fetchImpl,
        `${this.base}/rest/api/3/issue/${encodeURIComponent(created.key)}/attachments`,
        { method: 'POST', headers: this.headers({ 'X-Atlassian-Token': 'no-check' }), body: form },
        'Jira upload attachment',
      );
    }
    return { id: created.key, url: `${this.base}/browse/${created.key}` };
  }

  async getStatus(externalId: string): Promise<ExternalStatus> {
    const issue = await this.json<{ fields: { status: { name: string; statusCategory?: { key?: string } } } }>(
      `/rest/api/3/issue/${encodeURIComponent(externalId)}?fields=status`,
      'Jira get issue',
    );
    return { name: issue.fields.status.name, state: issue.fields.status.statusCategory?.key ?? 'new' };
  }

  /** `new` -> open, `indeterminate` -> in-progress, `done` -> fixed. */
  mapStatus(external: ExternalStatus): DefectStatus {
    if (external.state === 'done') return 'fixed';
    if (external.state === 'indeterminate') return 'in-progress';
    return 'open';
  }

  async addComment(externalId: string, body: string): Promise<void> {
    await this.json(`/rest/api/3/issue/${encodeURIComponent(externalId)}/comment`, 'Jira add comment', 'POST', {
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] },
    });
  }
}
