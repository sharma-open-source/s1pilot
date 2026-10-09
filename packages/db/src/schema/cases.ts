import type {
  Parameters,
  Precondition,
  ResolvedAction,
  Step,
  TestCase,
  LearnedScriptHealth,
} from '@s1pilot/domain';
import { index, integer, primaryKey, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

import { environments, projects, suites } from './core.js';

export const testCases = sqliteTable(
  'test_cases',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    suiteId: text('suite_id').references(() => suites.id, { onDelete: 'set null' }),
    key: text('key').notNull().unique(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    priority: text('priority', { enum: ['P0', 'P1', 'P2', 'P3'] }).notNull(),
    type: text('type', { enum: ['smoke', 'regression', 'e2e', 'exploratory'] }).notNull(),
    status: text('status', { enum: ['draft', 'ready', 'deprecated'] }).notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
    requirements: text('requirements', { mode: 'json' }).$type<string[]>().notNull(),
    preconditions: text('preconditions', { mode: 'json' }).$type<Precondition[]>().notNull(),
    parameters: text('parameters', { mode: 'json' }).$type<Parameters>().notNull(),
    steps: text('steps', { mode: 'json' }).$type<Step[]>().notNull(),
    owner: text('owner'),
    externalRef: text('external_ref'),
    quarantined: integer('quarantined', { mode: 'boolean' }).notNull().default(false),
    quarantineReason: text('quarantine_reason'),
    quarantinedAt: text('quarantined_at'),
    flakiness: real('flakiness').notNull().default(0),
    version: integer('version').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    unique('test_cases_project_number_unq').on(t.projectId, t.number),
    index('test_cases_suite_idx').on(t.suiteId),
    index('test_cases_external_ref_idx').on(t.projectId, t.externalRef),
  ],
);

/** Full JSON snapshot of a case at each version. */
export const testCaseVersions = sqliteTable(
  'test_case_versions',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: text('snapshot', { mode: 'json' }).$type<TestCase>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [unique('test_case_versions_unq').on(t.caseId, t.version)],
);

export const sharedSteps = sqliteTable('shared_steps', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  params: text('params', { mode: 'json' }).$type<string[]>().notNull(),
  steps: text('steps', { mode: 'json' }).$type<Step[]>().notNull(),
});

export const requirements = sqliteTable(
  'requirements',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
  },
  (t) => [unique('requirements_project_key_unq').on(t.projectId, t.key)],
);

export const caseRequirements = sqliteTable(
  'case_requirements',
  {
    caseId: text('case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    requirementId: text('requirement_id')
      .notNull()
      .references(() => requirements.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.caseId, t.requirementId] })],
);

export const learnedScripts = sqliteTable(
  'learned_scripts',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    caseVersion: integer('case_version').notNull(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    actions: text('actions', { mode: 'json' }).$type<ResolvedAction[]>().notNull(),
    createdFromRunId: text('created_from_run_id').notNull(),
    health: text('health', { mode: 'json' }).$type<LearnedScriptHealth>().notNull(),
    createdAt: text('created_at'),
  },
  (t) => [unique('learned_scripts_case_env_unq').on(t.caseId, t.environmentId)],
);

export const healProposals = sqliteTable('heal_proposals', {
  id: text('id').primaryKey(),
  caseId: text('case_id')
    .notNull()
    .references(() => testCases.id, { onDelete: 'cascade' }),
  environmentId: text('environment_id')
    .notNull()
    .references(() => environments.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  stepIndex: integer('step_index').notNull(),
  before: text('before', { mode: 'json' }).$type<ResolvedAction[]>().notNull(),
  after: text('after', { mode: 'json' }).$type<ResolvedAction[]>().notNull(),
  confidence: real('confidence').notNull(),
  s2Agreed: integer('s2_agreed', { mode: 'boolean' }),
  approvedLive: text('approved_live'),
  sharedStepId: text('shared_step_id'),
  impactCaseIds: text('impact_case_ids', { mode: 'json' }).$type<string[]>().notNull(),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull(),
  createdAt: text('created_at'),
});
