import type {
  BrowserTarget,
  DataPolicy,
  ModelSettings,
  SensitiveAction,
} from '@s1pilot/domain';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  key: text('key').notNull().unique(),
  defaultEnvironmentId: text('default_environment_id'),
  modelSettings: text('model_settings', { mode: 'json' }).$type<ModelSettings>(),
  retentionDays: integer('retention_days').notNull().default(30),
  autoApplyHeals: integer('auto_apply_heals', { mode: 'boolean' }).notNull().default(false),
  dataPolicy: text('data_policy', { mode: 'json' }).$type<DataPolicy>().notNull(),
  /** Next human case number for this project (`KEY-TC-n`). */
  nextCaseNumber: integer('next_case_number').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const environments = sqliteTable(
  'environments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    allowDomains: text('allow_domains', { mode: 'json' }).$type<string[]>().notNull(),
    authSetupFlowId: text('auth_setup_flow_id'),
    browsers: text('browsers', { mode: 'json' }).$type<BrowserTarget[]>().notNull(),
    readOnly: integer('read_only', { mode: 'boolean' }).notNull(),
    requireApprovalFor: text('require_approval_for', { mode: 'json' })
      .$type<SensitiveAction[]>()
      .notNull(),
    locale: text('locale').notNull(),
    timezone: text('timezone').notNull(),
  },
  (t) => [index('environments_project_idx').on(t.projectId)],
);

export const variables = sqliteTable(
  'variables',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** Plaintext value; always null for secret variables. */
    value: text('value'),
    secret: integer('secret', { mode: 'boolean' }).notNull(),
    /** Encrypted blob for secret variables (encryption comes from S-004). */
    secretCiphertext: text('secret_ciphertext'),
    source: text('source', { enum: ['inline', 'env'] }).notNull(),
    envVar: text('env_var'),
  },
  (t) => [unique('variables_env_key_unq').on(t.environmentId, t.key)],
);

export const suites = sqliteTable(
  'suites',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnySQLiteColumn => suites.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('suites_project_idx').on(t.projectId)],
);

export const testDataSets = sqliteTable('test_data_sets', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  environmentId: text('environment_id').references(() => environments.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  rows: text('rows', { mode: 'json' }).$type<Record<string, string | number | boolean>[]>().notNull(),
});
