import type {
  BrowserTarget,
  DataPolicy,
  ModelSettings,
  SensitiveAction,
} from '@s1pilot/domain';
import { boolean, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  key: text('key').notNull().unique(),
  defaultEnvironmentId: text('default_environment_id'),
  modelSettings: jsonb('model_settings').$type<ModelSettings>(),
  retentionDays: integer('retention_days').notNull().default(30),
  autoApplyHeals: boolean('auto_apply_heals').notNull().default(false),
  dataPolicy: jsonb('data_policy').$type<DataPolicy>().notNull(),
  /** Next human case number for this project (`KEY-TC-n`). */
  nextCaseNumber: integer('next_case_number').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const environments = pgTable(
  'environments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    allowDomains: jsonb('allow_domains').$type<string[]>().notNull(),
    authSetupFlowId: text('auth_setup_flow_id'),
    browsers: jsonb('browsers').$type<BrowserTarget[]>().notNull(),
    readOnly: boolean('read_only').notNull(),
    requireApprovalFor: jsonb('require_approval_for')
      .$type<SensitiveAction[]>()
      .notNull(),
    locale: text('locale').notNull(),
    timezone: text('timezone').notNull(),
  },
  (t) => [index('environments_project_idx').on(t.projectId)],
);

export const variables = pgTable(
  'variables',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** Plaintext value; always null for secret variables. */
    value: text('value'),
    secret: boolean('secret').notNull(),
    /** Encrypted blob for secret variables (encryption comes from S-004). */
    secretCiphertext: text('secret_ciphertext'),
    source: text('source', { enum: ['inline', 'env'] }).notNull(),
    envVar: text('env_var'),
  },
  (t) => [unique('variables_env_key_unq').on(t.environmentId, t.key)],
);

export const suites = pgTable(
  'suites',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    parentId: text('parent_id').references((): AnyPgColumn => suites.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('suites_project_idx').on(t.projectId)],
);

export const testDataSets = pgTable('test_data_sets', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  environmentId: text('environment_id').references(() => environments.id, {
    onDelete: 'cascade',
  }),
  name: text('name').notNull(),
  rows: jsonb('rows').$type<Record<string, string | number | boolean>[]>().notNull(),
});
