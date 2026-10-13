import { z } from 'zod';

/** The four team roles (plan §10). */
export const ROLES = ['admin', 'lead', 'tester', 'viewer'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Everything a role can be allowed to do. Procedures declare the permission they need (S-067). */
export const PERMISSIONS = [
  /** View projects, cases, runs, reports. */
  'read',
  /** Create / edit cases, suites, requirements, shared steps, defects, drafts, imports, recordings. */
  'content:write',
  /** Start, cancel, control and manually execute runs. */
  'runs:execute',
  /** Decide review items and override verdicts. */
  'reviews:decide',
  /** Approve heal proposals (changes learned scripts for every case). */
  'approvals:decide',
  /** Create / edit / delete plans, schedules and triggers. */
  'plans:write',
  /** Create / edit / delete projects, environments and calibration. */
  'projects:manage',
  /** Release sign-off of a run. */
  'signoff',
  /** Reveal secret values. */
  'secrets:reveal',
  /** Read the audit log. */
  'audit:read',
  /** Workspace settings, models, integrations, tokens, notifications. */
  'settings:manage',
  /** Invite, change role of and deactivate users. */
  'users:manage',
] as const;
export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof PermissionSchema>;

const TESTER: readonly Permission[] = ['read', 'content:write', 'runs:execute', 'reviews:decide'];
const LEAD: readonly Permission[] = [
  ...TESTER,
  'approvals:decide',
  'plans:write',
  'projects:manage',
  'signoff',
  'secrets:reveal',
  'audit:read',
];

/** Permission matrix. `admin` has everything; `viewer` sees reports only. */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  viewer: ['read'],
  tester: TESTER,
  lead: LEAD,
  admin: PERMISSIONS,
};

/** Whether `role` holds `permission`. */
export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Short role descriptions for the UI (Settings › Users & roles). */
export const ROLE_SUMMARY: Readonly<Record<Role, string>> = {
  admin: 'Settings, models, users',
  lead: 'Plans, approvals, sign-off',
  tester: 'Cases, runs, reviews',
  viewer: 'Reports only',
};

/** Public view of a user (never contains the password hash). */
export const UserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  role: RoleSchema,
  status: z.enum(['active', 'deactivated']),
  hasPassword: z.boolean(),
  sso: z.boolean(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type User = z.infer<typeof UserSchema>;

/** One audit log entry. `before`/`after` hold only the changed fields, secrets redacted. */
export const AuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  projectKey: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
