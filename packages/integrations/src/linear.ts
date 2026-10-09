import { S1PilotError, type DefectStatus } from '@s1pilot/domain';

import { failure, requestJson } from './http.js';
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

const PRIORITY = { S1: 1, S2: 2, S3: 3, S4: 4 } as const;

interface GqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/** Linear (GraphQL). Screenshots are uploaded via `fileUpload` and embedded in the description. */
export class LinearTracker implements IssueTracker {
  readonly provider = 'linear' as const;
  private readonly url: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    creds: TrackerCredentials,
    private readonly mapping: TrackerMapping = {},
    opts: TrackerOptions = {},
  ) {
    this.url = creds.baseUrl || 'https://api.linear.app/graphql';
    this.token = creds.token;
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  private async gql<T>(query: string, variables: Record<string, unknown>, what: string): Promise<T> {
    const res = await requestJson<GqlResponse<T>>(
      this.fetchImpl,
      this.url,
      { method: 'POST', headers: { Authorization: this.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) },
      what,
    );
    if (res.errors?.length || !res.data) {
      throw new S1PilotError('TRACKER_HTTP', `${what}: ${res.errors?.map((e) => e.message).join('; ').slice(0, 200) || 'empty response'}`);
    }
    return res.data;
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      const me = await this.gql<{ viewer: { name?: string } }>('query { viewer { id name } }', {}, 'Linear sign-in');
      if (this.mapping.linearTeamId) {
        await this.gql('query($id: String!) { team(id: $id) { id } }', { id: this.mapping.linearTeamId }, 'Linear team');
      }
      return { ok: true, detail: `Signed in as ${me.viewer.name ?? 'unknown user'}` };
    } catch (error) {
      return failure(error);
    }
  }

  private async upload(a: TrackerAttachment): Promise<string> {
    const r = await this.gql<{ fileUpload: { uploadFile: { uploadUrl: string; assetUrl: string; headers: Array<{ key: string; value: string }> } } }>(
      'mutation($contentType: String!, $filename: String!, $size: Int!) { fileUpload(contentType: $contentType, filename: $filename, size: $size) { uploadFile { uploadUrl assetUrl headers { key value } } } }',
      { contentType: a.contentType, filename: a.filename, size: a.data.byteLength },
      'Linear upload attachment',
    );
    const f = r.fileUpload.uploadFile;
    const headers: Record<string, string> = { 'Content-Type': a.contentType, 'Cache-Control': 'public, max-age=31536000' };
    for (const h of f.headers) headers[h.key] = h.value;
    await requestJson(this.fetchImpl, f.uploadUrl, { method: 'PUT', headers, body: a.data as unknown as ArrayBuffer }, 'Linear upload attachment');
    return f.assetUrl;
  }

  async createIssue(defect: TrackerDefect, attachments: TrackerAttachment[]): Promise<CreatedIssue> {
    const teamId = this.mapping.linearTeamId;
    if (!teamId) throw new S1PilotError('TRACKER_CONFIG', 'No Linear team is mapped for this project');
    const embeds: string[] = [];
    for (const a of attachments) embeds.push(`![${a.filename}](${await this.upload(a)})`);
    const description = `${toMarkdown(buildSections(defect))}${embeds.length > 0 ? `\n${embeds.join('\n')}\n` : ''}`;
    const r = await this.gql<{ issueCreate: { success: boolean; issue?: { identifier: string; url: string } } }>(
      'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }',
      { input: { teamId, title: defect.title.slice(0, 250), description, priority: PRIORITY[defect.severity] } },
      'Linear create issue',
    );
    if (!r.issueCreate.success || !r.issueCreate.issue) throw new S1PilotError('TRACKER_HTTP', 'Linear create issue: not created');
    return { id: r.issueCreate.issue.identifier, url: r.issueCreate.issue.url };
  }

  async getStatus(externalId: string): Promise<ExternalStatus> {
    const r = await this.gql<{ issue: { state: { name: string; type: string } } }>(
      'query($id: String!) { issue(id: $id) { id state { name type } } }',
      { id: externalId },
      'Linear get issue',
    );
    return { name: r.issue.state.name, state: r.issue.state.type };
  }

  /** completed -> fixed, canceled -> closed, started -> in-progress, otherwise open. */
  mapStatus(external: ExternalStatus): DefectStatus {
    if (external.state === 'completed') return 'fixed';
    if (external.state === 'canceled') return 'closed';
    if (external.state === 'started') return 'in-progress';
    return 'open';
  }

  async addComment(externalId: string, body: string): Promise<void> {
    const issue = await this.gql<{ issue: { id: string } }>('query($id: String!) { issue(id: $id) { id } }', { id: externalId }, 'Linear get issue');
    await this.gql(
      'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
      { input: { issueId: issue.issue.id, body } },
      'Linear add comment',
    );
  }
}
