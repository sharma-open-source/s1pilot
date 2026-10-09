import type {
  AssertionVerdict,
  CheckSummary,
  DefectDetails,
  ExitCriterion,
  ManualStepRecord,
  MatrixEntry,
  PlanAssignment,
  PlanChecks,
  PlanSelection,
  ReviewOutcome,
  RunSummary,
} from '@s1pilot/domain';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { testCases } from './cases.js';
import { projects } from './core.js';

export const testPlans = sqliteTable('test_plans', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  release: text('release'),
  selection: text('selection', { mode: 'json' }).$type<PlanSelection>().notNull(),
  matrix: text('matrix', { mode: 'json' }).$type<MatrixEntry[]>().notNull(),
  retries: integer('retries').notNull(),
  parallelism: integer('parallelism').notNull(),
  mode: text('mode', { enum: ['replay-heal', 'explore', 'replay-only'] }).notNull(),
  unattended: text('unattended', { enum: ['block', 'pause'] }).notNull(),
  schedule: text('schedule'),
  exitCriteria: text('exit_criteria', { mode: 'json' }).$type<ExitCriterion[]>().notNull(),
  checks: text('checks', { mode: 'json' }).$type<PlanChecks>().notNull(),
  assignments: text('assignments', { mode: 'json' }).$type<Record<string, PlanAssignment>>().notNull().default({}),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

export const testRuns = sqliteTable(
  'test_runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    planId: text('plan_id').references(() => testPlans.id, { onDelete: 'set null' }),
    trigger: text('trigger', { enum: ['manual', 'schedule', 'ci', 'webhook', 'retest'] }).notNull(),
    buildRef: text('build_ref'),
    status: text('status', {
      enum: ['queued', 'running', 'paused', 'finished', 'aborted', 'passed', 'failed', 'needs-review', 'cancelled', 'error'],
    }).notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    summary: text('summary', { mode: 'json' }).$type<RunSummary>().notNull(),
  },
  (t) => [index('test_runs_project_idx').on(t.projectId)],
);

export const caseResults = sqliteTable(
  'case_results',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    caseId: text('case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    caseVersion: integer('case_version').notNull(),
    environmentId: text('environment_id'),
    browser: text('browser', { enum: ['chromium', 'firefox', 'webkit'] }),
    attempt: integer('attempt').notNull(),
    verdict: text('verdict', {
      enum: ['passed', 'failed', 'blocked', 'skipped', 'flaky', 'needs-review'],
    }).notNull(),
    confidence: real('confidence'),
    durationMs: real('duration_ms').notNull(),
    mode: text('mode', { enum: ['replay', 'healed', 'explore', 'manual'] }).notNull(),
    escalations: integer('escalations').notNull(),
    reason: text('reason'),
    checks: text('checks', { mode: 'json' }).$type<CheckSummary[]>(),
  },
  (t) => [index('case_results_run_idx').on(t.runId), index('case_results_case_idx').on(t.caseId)],
);

export const stepResults = sqliteTable(
  'step_results',
  {
    id: text('id').primaryKey(),
    caseResultId: text('case_result_id')
      .notNull()
      .references(() => caseResults.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    status: text('status', { enum: ['passed', 'failed', 'blocked', 'skipped'] }).notNull(),
    actionTaken: text('action_taken'),
    assertions: text('assertions', { mode: 'json' }).$type<AssertionVerdict[]>().notNull(),
    latencyMs: real('latency_ms').notNull(),
  },
  (t) => [index('step_results_case_idx').on(t.caseResultId)],
);

export const decisionRecords = sqliteTable(
  'decision_records',
  {
    id: text('id').primaryKey(),
    stepResultId: text('step_result_id')
      .notNull()
      .references(() => stepResults.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    questionId: text('question_id').notNull(),
    options: text('options', { mode: 'json' }).$type<string[]>().notNull(),
    probabilities: text('probabilities', { mode: 'json' })
      .$type<Record<string, number>>()
      .notNull(),
    chosen: text('chosen'),
    confidence: real('confidence').notNull(),
    model: text('model').notNull(),
    latencyMs: real('latency_ms').notNull(),
    escalatedTo: text('escalated_to', { enum: ['system2', 'human'] }),
    decidedBy: text('decided_by'),
    via: text('via', { enum: ['live', 'cli', 'api'] }),
  },
  (t) => [index('decision_records_step_idx').on(t.stepResultId)],
);

export const evidence = sqliteTable(
  'evidence',
  {
    id: text('id').primaryKey(),
    stepResultId: text('step_result_id')
      .notNull()
      .references(() => stepResults.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    kind: text('kind', {
      enum: ['screenshot', 'video', 'trace', 'log', 'console', 'network', 'dom', 'a11y'],
    }).notNull(),
    artifactId: text('artifact_id').notNull(),
  },
  (t) => [index('evidence_step_idx').on(t.stepResultId)],
);

export const defects = sqliteTable('defects', {
  id: text('id').primaryKey(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  seq: integer('seq'),
  description: text('description'),
  details: text('details', { mode: 'json' }).$type<DefectDetails>(),
  severity: text('severity', { enum: ['S1', 'S2', 'S3', 'S4'] }).notNull(),
  status: text('status', { enum: ['draft', 'open', 'in-progress', 'fixed', 'closed'] }).notNull(),
  externalProvider: text('external_provider', { enum: ['jira', 'github', 'linear'] }),
  externalId: text('external_id'),
  externalUrl: text('external_url'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

export const defectResults = sqliteTable(
  'defect_results',
  {
    defectId: text('defect_id')
      .notNull()
      .references(() => defects.id, { onDelete: 'cascade' }),
    caseResultId: text('case_result_id')
      .notNull()
      .references(() => caseResults.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.defectId, t.caseResultId] })],
);

export const reviewItems = sqliteTable(
  'review_items',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['verdict', 'heal', 'decision'] }).notNull(),
    refId: text('ref_id').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull(),
    note: text('note'),
    outcome: text('outcome', { mode: 'json' }).$type<ReviewOutcome>(),
    createdAt: text('created_at'),
    resolvedAt: text('resolved_at'),
  },
  (t) => [index('review_items_project_status_idx').on(t.projectId, t.status)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
});

/** Durable job queue (S-034). Rows are managed through `createSqliteJobQueue`, not a repo. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    /** Run the job belongs to, when any (no FK: queue rows may outlive or precede run rows). */
    runId: text('run_id'),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    status: text('status', { enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] }).notNull(),
    attempts: integer('attempts').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    workerId: text('worker_id'),
    leaseExpiresAt: text('lease_expires_at'),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [index('jobs_status_idx').on(t.status, t.type), index('jobs_run_idx').on(t.runId)],
);

/** Metadata of a stored artifact file (screenshot, video, trace, logs); the bytes live in the artifact store. */
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    caseResultId: text('case_result_id').notNull(),
    /** Step the artifact belongs to; null for case-level artifacts (video, trace, logs). */
    stepIndex: integer('step_index'),
    kind: text('kind', {
      enum: ['screenshot', 'video', 'trace', 'log', 'console', 'network', 'dom', 'a11y'],
    }).notNull(),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    /** File path relative to the store root. */
    path: text('path').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('artifacts_project_idx').on(t.projectId, t.createdAt), index('artifacts_result_idx').on(t.caseResultId)],
);

/** Manual / hybrid execution item: one tester working through one case in one run (S-055). */
export const manualItems = sqliteTable(
  'manual_items',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => testRuns.id, { onDelete: 'cascade' }),
    caseId: text('case_id')
      .notNull()
      .references(() => testCases.id, { onDelete: 'cascade' }),
    environmentId: text('environment_id'),
    browser: text('browser', { enum: ['chromium', 'firefox', 'webkit'] }),
    device: text('device'),
    assignee: text('assignee').notNull(),
    hybrid: integer('hybrid', { mode: 'boolean' }).notNull(),
    position: integer('position').notNull(),
    status: text('status', { enum: ['todo', 'in-progress', 'done', 'skipped'] }).notNull(),
    steps: text('steps', { mode: 'json' }).$type<ManualStepRecord[]>().notNull(),
    confirmedSteps: text('confirmed_steps', { mode: 'json' }).$type<number[]>().notNull(),
    notes: text('notes').notNull(),
    elapsedMs: real('elapsed_ms').notNull(),
    timerStartedAt: text('timer_started_at'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    caseResultId: text('case_result_id'),
  },
  (t) => [index('manual_items_assignee_idx').on(t.assignee, t.status), index('manual_items_run_idx').on(t.runId)],
);
