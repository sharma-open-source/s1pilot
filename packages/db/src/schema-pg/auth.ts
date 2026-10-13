import type { AuthValidation } from '@s1pilot/domain';
import { index, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';

import { environments } from './core.js';

/** Saved logins per environment. The storage state is stored only as vault ciphertext. */
export const authSetups = pgTable(
  'auth_setups',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['recorded', 'flow'] }).notNull(),
    flowId: text('flow_id'),
    /** Vault-encrypted Playwright storage state (JSON); never plaintext. */
    stateCiphertext: text('state_ciphertext'),
    lastRefreshedAt: text('last_refreshed_at'),
    status: text('status', { enum: ['valid', 'expired', 'never'] }).notNull(),
    validation: jsonb('validation').$type<AuthValidation>(),
  },
  (t) => [unique('auth_setups_env_name_unq').on(t.environmentId, t.name)],
);

/** API tokens for CLI / CI (S-059). Only a salted scrypt hash is stored; the token itself is shown once at creation. */
export const apiTokens = pgTable('api_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Public, non-secret lookup part of the token (`s1p_<prefix>_…`); the only part shown after creation. */
  prefix: text('prefix').notNull().unique(),
  /** `scrypt$<saltHex>$<hashHex>` of the full token. */
  hash: text('hash').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});


/** Team-mode users (S-067). `passwordHash` is an argon2id hash; SSO-only users have none. */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** Lower-cased. */
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    passwordHash: text('password_hash'),
    role: text('role', { enum: ['admin', 'lead', 'tester', 'viewer'] }).notNull(),
    status: text('status', { enum: ['active', 'deactivated'] }).notNull(),
    oidcIssuer: text('oidc_issuer'),
    oidcSubject: text('oidc_subject'),
    createdAt: text('created_at').notNull(),
    lastLoginAt: text('last_login_at'),
  },
  (t) => [index('users_oidc_idx').on(t.oidcIssuer, t.oidcSubject)],
);

/** Login sessions. Only a SHA-256 of the cookie token is stored; the previous token stays valid for a short grace period after a rotation. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    prevTokenHash: text('prev_token_hash'),
    createdAt: text('created_at').notNull(),
    rotatedAt: text('rotated_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

/** Invite links created by an admin. Only a SHA-256 of the link token is stored. */
export const invites = pgTable('invites', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  role: text('role', { enum: ['admin', 'lead', 'tester', 'viewer'] }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  acceptedAt: text('accepted_at'),
  revokedAt: text('revoked_at'),
});

/** Audit log of edits, approvals, overrides and settings changes. `before` / `after` hold changed fields only, secrets redacted. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    at: text('at').notNull(),
    actorId: text('actor_id').notNull(),
    actorName: text('actor_name').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    projectKey: text('project_key'),
    before: jsonb('before').$type<unknown>(),
    after: jsonb('after').$type<unknown>(),
    ip: text('ip'),
  },
  (t) => [index('audit_log_at_idx').on(t.at), index('audit_log_action_idx').on(t.action, t.at), index('audit_log_actor_idx').on(t.actorId, t.at)],
);
