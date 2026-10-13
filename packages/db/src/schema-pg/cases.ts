import type {
  Parameters,
  Precondition,
  ResolvedAction,
  Step,
  TestCase,
  LearnedScriptHealth,
} from '@s1pilot/domain';
import { boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';

import { environments, projects, suites } from './core.js';

export const testCases = pgTable(
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
    tags: jsonb('tags').$type<string[]>().notNull(),
    requirements: jsonb('requirements').$type<string[]>().notNull(),
    preconditions: jsonb('preconditions').$type<Precondition[]>().notNull(),
    parameters: jsonb('parameters').$type<Parameters>().notNull(),
    steps: jsonb('steps').$type<Step[]>().notNull(),
    owner: text('owner'),
    externalRef: text('external_ref'),
    quarantined: boolean('quarantined').notNull().default(false),
    quarantineReason: text('quarantine_reason'),
    quarantinedAt: text('quarantined_at'),
    flakiness: doublePrecision('flakiness').notNull().default(0),
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
export const testCaseVersions = pgTable(
  'test_case_versions',
  {
    id: text('id').primaryKey(),
    caseId: text('case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').$type<TestCase>().notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [unique('test_case_versions_unq').on(t.caseId, t.version)],
);

export const sharedSteps = pgTable('shared_steps', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  params: jsonb('params').$type<string[]>().notNull(),
  steps: jsonb('steps').$type<Step[]>().notNull(),
});

export const requirements = pgTable(
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

export const caseRequirements = pgTable(
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

export const learnedScripts = pgTable(
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
    actions: jsonb('actions').$type<ResolvedAction[]>().notNull(),
    createdFromRunId: text('created_from_run_id').notNull(),
    health: jsonb('health').$type<LearnedScriptHealth>().notNull(),
    createdAt: text('created_at'),
  },
  (t) => [unique('learned_scripts_case_env_unq').on(t.caseId, t.environmentId)],
);

export const healProposals = pgTable('heal_proposals', {
  id: text('id').primaryKey(),
  caseId: text('case_id')
    .notNull()
    .references(() => testCases.id, { onDelete: 'cascade' }),
  environmentId: text('environment_id')
    .notNull()
    .references(() => environments.id, { onDelete: 'cascade' }),
  runId: text('run_id').notNull(),
  stepIndex: integer('step_index').notNull(),
  before: jsonb('before').$type<ResolvedAction[]>().notNull(),
  after: jsonb('after').$type<ResolvedAction[]>().notNull(),
  confidence: doublePrecision('confidence').notNull(),
  s2Agreed: boolean('s2_agreed'),
  approvedLive: text('approved_live'),
  sharedStepId: text('shared_step_id'),
  impactCaseIds: jsonb('impact_case_ids').$type<string[]>().notNull(),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull(),
  createdAt: text('created_at'),
});
