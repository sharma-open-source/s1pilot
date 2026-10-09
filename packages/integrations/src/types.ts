import type { DefectStatus } from '@s1pilot/domain';

/** Supported issue trackers. */
export type TrackerProvider = 'jira' | 'github' | 'linear';

/** The fields of a defect that are pushed to a tracker (no secrets, no internal ids). */
export interface TrackerDefect {
  /** Human key, e.g. `DEF-12`. */
  key: string;
  title: string;
  severity: 'S1' | 'S2' | 'S3' | 'S4';
  description?: string | undefined;
  stepsToReproduce: string[];
  expected: string;
  actual: string;
  environment?: string | undefined;
  browser?: string | undefined;
  buildRef?: string | undefined;
  /** Origin label, e.g. `SHOP-TC-44`. */
  sourceLabel?: string | undefined;
}

/** A file uploaded with an issue (screenshot). */
export interface TrackerAttachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

/** Reference to a created issue. `id` is what `getStatus` / `addComment` take (Jira key, GitHub number, Linear identifier). */
export interface CreatedIssue {
  id: string;
  url: string;
}

/** Status as reported by the tracker. `state` is the tracker's coarse category (see each tracker's `mapStatus`). */
export interface ExternalStatus {
  /** Display name of the tracker status, e.g. `In Review`. */
  name: string;
  /** Jira: `new|indeterminate|done`; GitHub: `open|closed|closed:not_planned`; Linear: state type. */
  state: string;
}

export interface ConnectionResult {
  ok: boolean;
  /** Human-readable detail, e.g. the authenticated account. Never contains credentials. */
  detail: string;
}

/** Common interface of all issue trackers. */
export interface IssueTracker {
  readonly provider: TrackerProvider;
  /** Verifies credentials (and the configured project / repo / team when set). Never throws for auth failures. */
  testConnection(): Promise<ConnectionResult>;
  /** Creates the issue (title, repro steps, expected / actual, environment) and uploads the attachments where the tracker supports it. */
  createIssue(defect: TrackerDefect, attachments: TrackerAttachment[]): Promise<CreatedIssue>;
  getStatus(externalId: string): Promise<ExternalStatus>;
  /** Maps a tracker status to the local defect status. */
  mapStatus(external: ExternalStatus): DefectStatus;
  addComment(externalId: string, body: string): Promise<void>;
}

/** Credentials entered in Settings; stored encrypted by the server, never returned to the UI. */
export interface TrackerCredentials {
  /** Jira site URL (`https://acme.atlassian.net`); optional API base for GitHub / Linear. */
  baseUrl?: string | undefined;
  /** Jira account email. */
  email?: string | undefined;
  /** API token / personal access token / API key. */
  token: string;
}

/** Per-project target. */
export interface TrackerMapping {
  /** Jira project key. */
  jiraProject?: string | undefined;
  /** Jira issue type name (default `Bug`). */
  jiraIssueType?: string | undefined;
  /** GitHub `owner/name`. */
  githubRepo?: string | undefined;
  /** Extra GitHub labels. */
  githubLabels?: string[] | undefined;
  /** Linear team id. */
  linearTeamId?: string | undefined;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TrackerOptions {
  /** Injected for tests; defaults to global `fetch`. */
  fetch?: FetchLike | undefined;
}
