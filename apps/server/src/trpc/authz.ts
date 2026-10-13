import type { Permission } from '@s1pilot/domain';

/** Procedures reachable without a session (login, first-run setup, invite acceptance, health). */
export const PUBLIC_PROCEDURES: ReadonlySet<string> = new Set([
  'health',
  'session.status',
  'session.me',
  'session.login',
  'session.logout',
  'session.setup',
  'session.inviteInfo',
  'session.acceptInvite',
]);

/** Exact procedure paths that need something other than the default for their type. */
const EXACT: Readonly<Record<string, Permission>> = {
  'users.options': 'read',
  'models.probe': 'settings:manage',
  'models.updateSettings': 'settings:manage',
  'workspace.update': 'settings:manage',
  'workspace.purge': 'settings:manage',
  'environments.revealSecret': 'secrets:reveal',
  'runs.signOff': 'signoff',
  'reviews.decide': 'reviews:decide',
  'results.overrideVerdict': 'reviews:decide',
  'trackers.setMapping': 'projects:manage',
  'trackers.push': 'content:write',
  'trackers.syncNow': 'content:write',
  'trackers.list': 'read',
  'trackers.mapping': 'read',
};

/** Path prefixes (first match wins) that apply to queries and mutations alike. */
const BOTH_PREFIXES: ReadonlyArray<readonly [string, Permission]> = [
  ['users.', 'users:manage'],
  ['audit.', 'audit:read'],
  ['tokens.', 'settings:manage'],
  ['notifications.', 'settings:manage'],
];

/** Path prefixes that only apply to mutations (reads stay `read`). */
const MUTATION_PREFIXES: ReadonlyArray<readonly [string, Permission]> = [
  ['trackers.', 'settings:manage'],
  ['projects.', 'projects:manage'],
  ['environments.', 'projects:manage'],
  ['calibration.', 'projects:manage'],
  ['auth.', 'projects:manage'],
  ['plans.', 'plans:write'],
  ['triggers.', 'plans:write'],
  ['runs.', 'runs:execute'],
  ['manual.', 'runs:execute'],
];

/**
 * Permission a procedure needs. Queries default to `read`, mutations to `content:write`; the tables above are
 * the exceptions. Viewers hold only `read`, so every mutation is a 403 for them.
 */
export function permissionFor(path: string, type: 'query' | 'mutation' | 'subscription'): Permission {
  const exact = EXACT[path];
  if (exact) return exact;
  for (const [prefix, permission] of BOTH_PREFIXES) if (path.startsWith(prefix)) return permission;
  if (type === 'mutation') {
    for (const [prefix, permission] of MUTATION_PREFIXES) if (path.startsWith(prefix)) return permission;
    return 'content:write';
  }
  return 'read';
}
