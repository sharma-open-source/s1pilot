/** Settings sections in nav order (wireframe 13). The slug is the `/settings/:section` param. */
export const SETTINGS_SECTIONS = [
  { slug: 'general', label: 'General' },
  { slug: 'models', label: 'Models & endpoints' },
  { slug: 'integrations', label: 'Integrations' },
  { slug: 'notifications', label: 'Notifications' },
  { slug: 'users', label: 'Users & roles', badge: 'team mode' },
  { slug: 'data', label: 'Data & retention' },
  { slug: 'workers', label: 'Workers' },
  { slug: 'tokens', label: 'API tokens & CLI' },
  { slug: 'audit', label: 'Audit log' },
] as const;

export type SettingsSlug = (typeof SETTINGS_SECTIONS)[number]['slug'];

/** Returns the slug when it names a section, else `undefined`. */
export function parseSection(raw: string): SettingsSlug | undefined {
  return SETTINGS_SECTIONS.find((s) => s.slug === raw)?.slug;
}

// TODO(S-064): real status and actions for the other integration cards; only GitHub Actions and GitLab CI are live (S-063).
export const INTEGRATIONS = [
  { name: 'GitHub Actions', description: 'Run plans in CI, comment on PRs', action: 'Configure' },
  { name: 'GitLab CI', description: 'Pipeline template + JUnit upload', action: 'Configure' },
  { name: 'Jira', description: 'Push defects, sync status, link requirements', action: 'Configure' },
  { name: 'Linear · GitHub Issues', description: 'Alternative defect trackers', action: 'Connect' },
  { name: 'Slack · Teams', description: 'Run finished, approval needed, review queue', action: 'Configure' },
  { name: 'Webhooks', description: 'Trigger plans on deploy; send results out', action: 'Manage' },
  { name: 'Import', description: 'CSV, Gherkin, TestRail, Xray, Playwright specs', action: 'Start import' },
  { name: 'MCP server', description: 'Let other agents list and run tests', action: 'Coming soon' },
] as const;

export const ROLES = [
  { name: 'Admin', can: 'Settings, models, users' },
  { name: 'QA lead', can: 'Plans, approvals, sign-off' },
  { name: 'Tester', can: 'Cases, runs, reviews' },
  { name: 'Viewer', can: 'Reports only' },
] as const;

export const TOKEN_SCOPE_LABELS = {
  'runs:write': 'Start and change runs',
  'results:read': 'Read results',
} as const;

/** The CLI command shown under "Run from CI or terminal". Never contains a token value, only `$S1P_TOKEN`. */
export function ciCommand(opts: { server: string; plan?: string | undefined; env?: string | undefined }): string {
  const plan = opts.plan !== undefined && opts.plan !== '' ? opts.plan : 'Checkout regression';
  const env = opts.env !== undefined && opts.env !== '' ? opts.env : 'staging';
  return `npx s1pilot run --plan "${plan}" --env ${env} \\\n  --server ${opts.server} --token $S1P_TOKEN \\\n  --reporter junit,html`;
}

/** Relative "5 minutes ago" style text, or "Never". */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'Never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** Cards that show CI usage and a "Configure" snippet panel, keyed to the provider the CLI reports (S-063). */
export const CI_CARDS = { 'GitHub Actions': 'github', 'GitLab CI': 'gitlab' } as const;

/** Example GitHub Actions workflow using the composite action. Contains no token value, only the secret reference. */
export function githubWorkflowSnippet(opts: { server: string; plan?: string | undefined; env?: string | undefined }): string {
  return [
    'name: s1pilot',
    'on: pull_request',
    'permissions:',
    '  contents: read',
    '  pull-requests: write',
    'jobs:',
    '  s1pilot:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: s1pilot/run-action@v1',
    '        with:',
    `          plan: ${opts.plan || 'Smoke'}`,
    `          env: ${opts.env || 'staging'}`,
    `          server: ${opts.server}`,
    '          token: ${{ secrets.S1PILOT_TOKEN }}',
    '          reporter: junit,html',
  ].join('\n');
}

/** Example GitLab CI job using the `.gitlab/s1pilot.yml` template. */
export function gitlabSnippet(opts: { server: string; plan?: string | undefined; env?: string | undefined }): string {
  return [
    'include:',
    '  - local: .gitlab/s1pilot.yml',
    '',
    's1pilot:',
    '  extends: .s1pilot-run',
    '  variables:',
    `    S1PILOT_PLAN: "${opts.plan || 'Smoke'}"`,
    `    S1PILOT_ENV: ${opts.env || 'staging'}`,
    `    S1PILOT_SERVER: ${opts.server}`,
    '    # S1PILOT_TOKEN: set as a masked CI/CD variable',
  ].join('\n');
}

export type TrackerProvider = 'jira' | 'github' | 'linear';

/** Issue tracker cards (S-064); they replace the Jira and "Linear · GitHub Issues" placeholders of `INTEGRATIONS`. */
export const TRACKERS = [
  { provider: 'jira', name: 'Jira', description: 'Push defects, sync status, link requirements', tokenLabel: 'API token', help: 'Jira Cloud. Create an API token in your Atlassian account and enter it with the account email.' },
  { provider: 'github', name: 'GitHub Issues', description: 'Push defects to a repository, close to re-test', tokenLabel: 'Personal access token', help: 'Token with permission to create issues in the repository.' },
  { provider: 'linear', name: 'Linear', description: 'Push defects to a team, sync status', tokenLabel: 'API key', help: 'Personal API key from Linear settings.' },
] as const satisfies ReadonlyArray<{ provider: TrackerProvider; name: string; description: string; tokenLabel: string; help: string }>;

/** Placeholder names in `INTEGRATIONS` replaced by the tracker cards. */
export const TRACKER_PLACEHOLDERS: readonly string[] = ['Jira', 'Linear · GitHub Issues'];
