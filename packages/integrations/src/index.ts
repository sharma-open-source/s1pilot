/** Package name. */
export const INTEGRATIONS_PACKAGE = '@s1pilot/integrations';

export * from './notify.js';

import { S1PilotError } from '@s1pilot/domain';

import { GithubTracker } from './github.js';
import { JiraTracker } from './jira.js';
import { LinearTracker } from './linear.js';
import type { IssueTracker, TrackerCredentials, TrackerMapping, TrackerOptions, TrackerProvider } from './types.js';

export { JiraTracker } from './jira.js';
export { GithubTracker } from './github.js';
export { LinearTracker } from './linear.js';
export { buildSections, toAdf, toMarkdown } from './render.js';
export type { Section } from './render.js';
export type {
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
  TrackerProvider,
} from './types.js';

/** Creates the tracker implementation for a provider. Throws `TRACKER_CONFIG` for missing required settings. */
export function createTracker(
  provider: TrackerProvider,
  creds: TrackerCredentials,
  mapping: TrackerMapping = {},
  opts: TrackerOptions = {},
): IssueTracker {
  switch (provider) {
    case 'jira':
      return new JiraTracker(creds, mapping, opts);
    case 'github':
      return new GithubTracker(creds, mapping, opts);
    case 'linear':
      return new LinearTracker(creds, mapping, opts);
    default:
      throw new S1PilotError('TRACKER_CONFIG', `Unknown tracker: ${String(provider)}`);
  }
}
