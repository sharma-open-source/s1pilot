import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { repos, type Db } from '@s1pilot/db';
import {
  BrowserNameSchema,
  DataPolicySchema,
  ExecutionModeSchema,
  ExitCriterionSchema,
  PlanChecksSchema,
  S1PilotError,
  StepSchema,
  TestCaseFileSchema,
  newId,
  parseCaseKey,
  type Parameters,
  type Precondition,
  type Priority,
  type Step,
  type TestCaseStatus,
  type TestCaseType,
  type TestPlan,
  type Variable,
} from '@s1pilot/domain';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

import { unifiedDiff } from './diff.js';
import { normalizeFlowSteps } from './flows.js';
import { EnvironmentFileSchema, ProjectFileSchema, listYamlFiles, PROJECT_DIR, PROJECT_FILE, type ProjectModelFile } from './load.js';

/** Kinds of synced entities. */
export type SyncKind = 'project' | 'environment' | 'flow' | 'case' | 'plan';

/** One entity touched by a sync. `id` is the project key, case key, or the entity name. */
export interface SyncChange {
  kind: SyncKind;
  id: string;
  /** Path relative to the `.s1pilot/` folder. */
  file: string;
}

/** A case whose file is based on an older version than the DB holds and differs from it. */
export interface SyncConflict extends SyncChange {
  fileVersion: number;
  dbVersion: number;
  /** Unified diff, DB content to file content. */
  diff: string;
}

/** Result of {@link importProject}. */
export interface SyncPlan {
  creates: SyncChange[];
  updates: SyncChange[];
  conflicts: SyncConflict[];
  /** In the DB but not on disk. Only applied with `prune`. */
  deletes: SyncChange[];
}

/** Options for {@link importProject}. */
export interface ImportOptions {
  /** Compute the plan without writing to the DB. */
  dryRun?: boolean;
  /** Also delete DB entities that have no file. Off by default (deletions are destructive). */
  prune?: boolean;
}

/** Result of {@link exportProject}. */
export interface ExportResult {
  /** The `.s1pilot/` folder written to. */
  dir: string;
  /** Files created or changed, relative to {@link ExportResult.dir}. */
  written: string[];
  /** Stale files removed. */
  removed: string[];
}

/** Result of {@link syncStatus} when files and DB differ. */
export interface SyncDirty {
  changedFiles: string[];
  conflicts: SyncConflict[];
}

const MANAGED_DIRS = ['environments', 'suites', 'flows', 'plans'] as const;

/** Resolves the `.s1pilot` folder for a project root (or the folder itself). */
export function syncDir(dir: string): string {
  const abs = resolve(dir);
  if (existsSync(join(abs, PROJECT_FILE))) return abs;
  if (basename(abs) === PROJECT_DIR) return abs;
  return join(abs, PROJECT_DIR);
}

// ---------------------------------------------------------------------------------------------
// Content types (name based, no database ids) and their deterministic YAML rendering
// ---------------------------------------------------------------------------------------------

interface ProjectContent {
  key: string;
  name: string;
  defaultEnvironment?: string;
  retentionDays: number;
  dataPolicy: z.infer<typeof DataPolicySchema>;
  model?: ProjectModelFile;
}

interface EnvContent {
  name: string;
  baseUrl: string;
  variables: Variable[];
  allowDomains: string[];
  authSetupFlow?: string;
  browsers: { browser: 'chromium' | 'firefox' | 'webkit'; device?: string }[];
  readOnly: boolean;
  requireApprovalFor: ('pay' | 'delete' | 'send')[];
  locale: string;
  timezone: string;
}

interface FlowContent {
  name: string;
  params: string[];
  steps: Step[];
}

interface CaseContent {
  key: string;
  /** Version the file is based on; absent for hand-written files. */
  version?: number;
  suitePath: string[];
  title: string;
  priority: Priority;
  type: TestCaseType;
  status: TestCaseStatus;
  tags: string[];
  requirements: string[];
  owner?: string;
  preconditions: Precondition[];
  parameters: Parameters;
  /** `sharedStepId` holds the flow *name*. */
  steps: Step[];
}

interface PlanContent {
  name: string;
  release?: string;
  selection: { kind: 'list'; cases: string[] } | { kind: 'query'; query: string };
  matrix: { environment: string; browser: 'chromium' | 'firefox' | 'webkit'; device?: string }[];
  retries: number;
  parallelism: number;
  mode: z.infer<typeof ExecutionModeSchema>;
  unattended: 'block' | 'pause';
  schedule?: string;
  exitCriteria: z.infer<typeof ExitCriterionSchema>[];
  checks: z.infer<typeof PlanChecksSchema>;
}

type Plain = Record<string, unknown>;

/** Recursively sorts object keys (arrays keep their order). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Plain)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

const sorted = (items: readonly string[]): string[] => [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function toYaml(doc: Plain): string {
  const clean = Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined));
  return stringify(clean, { lineWidth: 0, sortMapEntries: false });
}

function stepDoc(s: Step): Plain {
  return {
    ...(s.sharedStepId !== undefined ? { flow: s.sharedStepId } : { action: s.action }),
    expected: s.expected,
    assert: s.assert.length > 0 ? s.assert.map(sortKeys) : undefined,
    inputs: s.inputs.length > 0 ? s.inputs : undefined,
    args: s.args !== undefined ? sortKeys(s.args) : undefined,
  };
}

const nonEmpty = <T>(a: T[]): T[] | undefined => (a.length > 0 ? a : undefined);

function renderProject(p: ProjectContent): string {
  return toYaml({
    key: p.key,
    name: p.name,
    defaultEnvironment: p.defaultEnvironment,
    retentionDays: p.retentionDays,
    dataPolicy: sortKeys(p.dataPolicy),
    model: p.model ? sortKeys(p.model) : undefined,
  });
}

function variableDoc(v: Variable): Plain {
  if (v.source === 'env') return { key: v.key, value: `env:${v.envVar ?? ''}`, secret: v.secret || undefined };
  // Secret values never leave the DB.
  if (v.secret) return { key: v.key, secret: true };
  return { key: v.key, value: v.value };
}

function renderEnv(e: EnvContent): string {
  return toYaml({
    name: e.name,
    baseUrl: e.baseUrl,
    variables: nonEmpty([...e.variables].sort((a, b) => (a.key < b.key ? -1 : 1)).map(variableDoc)),
    allowDomains: nonEmpty(sorted(e.allowDomains)),
    authSetupFlow: e.authSetupFlow,
    browsers: e.browsers.map((b) => ({ browser: b.browser, device: b.device })),
    readOnly: e.readOnly,
    requireApprovalFor: sorted(e.requireApprovalFor),
    locale: e.locale,
    timezone: e.timezone,
  });
}

function renderFlow(f: FlowContent): string {
  return toYaml({ name: f.name, params: nonEmpty(f.params), steps: f.steps.map(stepDoc) });
}

function renderCase(c: CaseContent, withVersion: boolean): string {
  return toYaml({
    key: c.key,
    version: withVersion ? c.version : undefined,
    title: c.title,
    priority: c.priority,
    type: c.type,
    status: c.status,
    tags: nonEmpty(sorted(c.tags)),
    requirements: nonEmpty(sorted(c.requirements)),
    owner: c.owner,
    preconditions: nonEmpty(c.preconditions.map((p) => sortKeys(p))),
    parameters: nonEmpty(c.parameters.map((p) => sortKeys(p))),
    steps: c.steps.map(stepDoc),
  });
}

/** Text used to compare/diff cases: the file body plus where the case lives. */
function caseCompareText(c: CaseContent): string {
  return `# suite: ${c.suitePath.join('/')}\n${renderCase(c, false)}`;
}

function renderPlan(p: PlanContent): string {
  const matrix = [...p.matrix].sort((a, b) =>
    `${a.environment}|${a.browser}|${a.device ?? ''}` < `${b.environment}|${b.browser}|${b.device ?? ''}` ? -1 : 1,
  );
  return toYaml({
    name: p.name,
    release: p.release,
    selection: p.selection.kind === 'list' ? { kind: 'list', cases: sorted(p.selection.cases) } : p.selection,
    matrix: matrix.map((m) => ({ environment: m.environment, browser: m.browser, device: m.device })),
    retries: p.retries,
    parallelism: p.parallelism,
    mode: p.mode,
    unattended: p.unattended,
    schedule: p.schedule,
    exitCriteria: nonEmpty(p.exitCriteria.map((c) => sortKeys(c))),
    checks: sortKeys(p.checks),
  });
}

// ---------------------------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------------------------

/** Makes a string safe as one path segment (never `.`-leading, no separators). */
function safeSegment(name: string): string {
  const s = name.replace(/[\\/:*?"<>|]/g, '-').trim().replace(/^\.+/, '_');
  return s.length > 0 ? s : '_';
}

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s.length > 0 ? s : 'item';
}

const projectPath = PROJECT_FILE;
const envPath = (name: string): string => `environments/${safeSegment(name)}.yaml`;
const flowPath = (name: string): string => `flows/${safeSegment(name)}.yaml`;
const planPath = (name: string): string => `plans/${slug(name)}.yaml`;
const casePath = (c: Pick<CaseContent, 'key' | 'title' | 'suitePath'>): string =>
  ['suites', ...c.suitePath.map(safeSegment), `${c.key.toLowerCase()}-${slug(c.title)}.yaml`].join('/');

// ---------------------------------------------------------------------------------------------
// Database -> contents
// ---------------------------------------------------------------------------------------------

interface DbBundle {
  projectId: string;
  project: ProjectContent;
  envs: { id: string; content: EnvContent }[];
  flows: { id: string; content: FlowContent }[];
  cases: { id: string; version: number; content: CaseContent }[];
  plans: { id: string; content: PlanContent }[];
  suiteIdByPath: Map<string, string>;
}

async function readDb(db: Db, projectId: string): Promise<DbBundle> {
  const project = await repos.projects.get(db, projectId);
  if (!project) throw new S1PilotError('NOT_FOUND', `Project not found: ${projectId}`, { projectId });
  const [envs, flows, suites, cases, plans] = await Promise.all([
    repos.environments.listByProject(db, projectId),
    repos.sharedSteps.listByProject(db, projectId),
    repos.suites.listByProject(db, projectId),
    repos.cases.list(db, { projectId }),
    repos.plans.listByProject(db, projectId),
  ]);
  const envName = new Map(envs.map((e) => [e.id, e.name]));
  const flowName = new Map(flows.map((f) => [f.id, f.name]));
  const caseKeyById = new Map(cases.map((c) => [c.id, c.key]));
  const flowRef = (id: string): string => flowName.get(id) ?? id;
  const mapSteps = (steps: Step[]): Step[] =>
    steps.map((s) => (s.sharedStepId !== undefined ? { ...s, sharedStepId: flowRef(s.sharedStepId) } : s));

  const suiteById = new Map(suites.map((s) => [s.id, s]));
  const suitePath = (id: string | undefined): string[] => {
    const out: string[] = [];
    let cur = id === undefined ? undefined : suiteById.get(id);
    for (let guard = 0; cur && guard < 64; guard++) {
      out.unshift(safeSegment(cur.name));
      cur = cur.parentId === undefined ? undefined : suiteById.get(cur.parentId);
    }
    return out;
  };
  const suiteIdByPath = new Map(suites.map((s) => [suitePath(s.id).join('/'), s.id]));

  const model = project.modelSettings;
  return {
    projectId,
    project: {
      key: project.key,
      name: project.name,
      ...(project.defaultEnvironmentId !== undefined && envName.has(project.defaultEnvironmentId)
        ? { defaultEnvironment: envName.get(project.defaultEnvironmentId) as string }
        : {}),
      retentionDays: project.retentionDays,
      dataPolicy: project.dataPolicy,
      ...(model ? { model } : {}),
    },
    envs: envs.map((e) => ({
      id: e.id,
      content: {
        name: e.name,
        baseUrl: e.baseUrl,
        variables: e.variables,
        allowDomains: e.allowDomains,
        ...(e.authSetupFlowId !== undefined ? { authSetupFlow: flowRef(e.authSetupFlowId) } : {}),
        browsers: e.browsers,
        readOnly: e.readOnly,
        requireApprovalFor: e.requireApprovalFor,
        locale: e.locale,
        timezone: e.timezone,
      },
    })),
    flows: flows.map((f) => ({ id: f.id, content: { name: f.name, params: f.params, steps: mapSteps(f.steps) } })),
    cases: cases.map((c) => ({
      id: c.id,
      version: c.version,
      content: {
        key: c.key,
        version: c.version,
        suitePath: suitePath(c.suiteId),
        title: c.title,
        priority: c.priority,
        type: c.type,
        status: c.status,
        tags: c.tags,
        requirements: c.requirements,
        ...(c.owner !== undefined ? { owner: c.owner } : {}),
        preconditions: c.preconditions,
        parameters: c.parameters,
        steps: mapSteps(c.steps),
      },
    })),
    plans: plans.map((p) => ({ id: p.id, content: planContent(p, envName, caseKeyById) })),
    suiteIdByPath,
  };
}

function planContent(p: TestPlan, envName: Map<string, string>, caseKeyById: Map<string, string>): PlanContent {
  return {
    name: p.name,
    ...(p.release !== undefined ? { release: p.release } : {}),
    selection:
      p.selection.kind === 'list'
        ? { kind: 'list', cases: p.selection.caseIds.map((id) => caseKeyById.get(id) ?? id) }
        : { kind: 'query', query: p.selection.query },
    matrix: p.matrix.map((m) => ({
      environment: envName.get(m.environmentId) ?? m.environmentId,
      browser: m.browser,
      ...(m.device !== undefined ? { device: m.device } : {}),
    })),
    retries: p.retries,
    parallelism: p.parallelism,
    mode: p.mode,
    unattended: p.unattended,
    ...(p.schedule !== undefined ? { schedule: p.schedule } : {}),
    exitCriteria: p.exitCriteria,
    checks: p.checks,
  };
}

/** Renders everything the DB would write, keyed by path relative to `.s1pilot/`. */
function renderBundle(b: DbBundle): Map<string, string> {
  const files = new Map<string, string>();
  files.set(projectPath, renderProject(b.project));
  for (const e of b.envs) files.set(envPath(e.content.name), renderEnv(e.content));
  for (const f of b.flows) files.set(flowPath(f.content.name), renderFlow(f.content));
  for (const c of b.cases) files.set(casePath(c.content), renderCase(c.content, true));
  for (const p of b.plans) files.set(planPath(p.content.name), renderPlan(p.content));
  return files;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

function listManaged(root: string): string[] {
  const out: string[] = [];
  for (const sub of MANAGED_DIRS) {
    const base = join(root, sub);
    if (!existsSync(base)) continue;
    for (const file of listYamlFiles(base)) out.push(relative(root, file).split(sep).join('/'));
  }
  return out;
}

function pruneEmptyDirs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(join(dir, entry.name));
  }
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * Writes a project to `<dir>/.s1pilot/` (or `dir` itself when it already is that folder).
 * Output is deterministic (fixed key order, sorted lists), so diffs stay minimal. Managed files
 * (`project.yaml`, `environments/`, `suites/`, `flows/`, `plans/`) that no longer correspond to a DB
 * entity are removed; `data/` and everything else are left alone. Secret values are never written.
 */
export async function exportProject(db: Db, projectId: string, dir: string): Promise<ExportResult> {
  const root = syncDir(dir);
  const files = renderBundle(await readDb(db, projectId));
  const written: string[] = [];
  const removed: string[] = [];
  for (const [rel, text] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const abs = join(root, rel);
    if (existsSync(abs) && readFileSync(abs, 'utf8') === text) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    written.push(rel);
  }
  for (const rel of listManaged(root)) {
    if (files.has(rel)) continue;
    rmSync(join(root, rel));
    removed.push(rel);
  }
  for (const sub of MANAGED_DIRS) pruneEmptyDirs(join(root, sub));
  return { dir: root, written, removed };
}

// ---------------------------------------------------------------------------------------------
// Files -> contents
// ---------------------------------------------------------------------------------------------

function fileInvalid(rel: string, error: z.ZodError): S1PilotError {
  const text = error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
  return new S1PilotError('SYNC_FILE_INVALID', `${rel} is invalid:\n${text}`, { path: rel });
}

function parseDoc(rel: string, text: string): Plain {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (error) {
    throw new S1PilotError('YAML_INVALID', `${rel} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`, { path: rel });
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new S1PilotError('SYNC_FILE_INVALID', `${rel} must be a YAML mapping`, { path: rel });
  }
  return doc as Plain;
}

const EnvFileSchema = EnvironmentFileSchema.omit({ authSetupFlowId: true }).extend({ authSetupFlow: z.string().optional() });

function toEnvContent(e: z.infer<typeof EnvFileSchema>, rel: string): EnvContent {
  for (const v of e.variables) {
    if (v.secret && v.source === 'inline' && v.value !== undefined) {
      throw new S1PilotError('SECRET_IN_FILE', `${rel}: secret variable "${v.key}" must use an env: reference, not a value`, { path: rel });
    }
  }
  return {
    name: e.name,
    baseUrl: e.baseUrl,
    variables: e.variables.map((v) => ({
      key: v.key,
      ...(v.value !== undefined && !v.secret && v.source === 'inline' ? { value: v.value } : {}),
      secret: v.secret,
      source: v.source,
      ...(v.envVar !== undefined ? { envVar: v.envVar } : {}),
    })),
    allowDomains: e.allowDomains,
    ...(e.authSetupFlow !== undefined ? { authSetupFlow: e.authSetupFlow } : {}),
    browsers: e.browsers,
    readOnly: e.readOnly ?? /^prod(uction)?$/i.test(e.name),
    requireApprovalFor: e.requireApprovalFor,
    locale: e.locale,
    timezone: e.timezone,
  };
}

const FlowFileSchema = z.object({
  name: z.string().min(1).optional(),
  params: z.array(z.string()).default([]),
  steps: z.array(StepSchema).min(1, 'a flow needs at least one step'),
});

const CaseFileExtraSchema = z.object({ version: z.number().int().min(1).optional() });

const PlanFileSchema = z.object({
  name: z.string().min(1),
  release: z.string().optional(),
  selection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('list'), cases: z.array(z.string()) }),
    z.object({ kind: z.literal('query'), query: z.string().min(1) }),
  ]),
  matrix: z
    .array(z.object({ environment: z.string().min(1), browser: BrowserNameSchema, device: z.string().optional() }))
    .min(1, 'a plan needs at least one matrix entry'),
  retries: z.number().int().min(0).max(5).default(0),
  parallelism: z.number().int().min(1).default(1),
  mode: ExecutionModeSchema.default('replay-heal'),
  unattended: z.enum(['block', 'pause']).default('block'),
  schedule: z.string().optional(),
  exitCriteria: z.array(ExitCriterionSchema).default([]),
  checks: PlanChecksSchema.default({}),
});

interface FileBundle {
  project: ProjectContent;
  envs: Map<string, { rel: string; content: EnvContent }>;
  flows: Map<string, { rel: string; content: FlowContent }>;
  cases: Map<string, { rel: string; content: CaseContent }>;
  plans: Map<string, { rel: string; content: PlanContent }>;
}

function readText(root: string, rel: string): string {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch (error) {
    throw new S1PilotError('FILE_UNREADABLE', `Cannot read ${rel}: ${error instanceof Error ? error.message : String(error)}`, { path: rel });
  }
}

function addUnique<T>(map: Map<string, T>, id: string, value: T, what: string, rel: string): void {
  if (map.has(id)) throw new S1PilotError('SYNC_DUPLICATE', `${what} "${id}" is defined twice (second: ${rel})`, { path: rel });
  map.set(id, value);
}

function readFiles(root: string): FileBundle {
  if (!existsSync(join(root, PROJECT_FILE))) {
    throw new S1PilotError('SYNC_NOT_FOUND', `No ${PROJECT_FILE} in ${root}`, { path: root });
  }
  const projectParsed = ProjectFileSchema.safeParse(parseDoc(projectPath, readText(root, projectPath)));
  if (!projectParsed.success) throw fileInvalid(projectPath, projectParsed.error);
  const pf = projectParsed.data;

  const envs: FileBundle['envs'] = new Map();
  // Environments written inline in project.yaml are accepted; environments/<name>.yaml wins.
  for (const inline of pf.environments) {
    const parsed = EnvFileSchema.parse(inline);
    envs.set(parsed.name, { rel: projectPath, content: toEnvContent(parsed, projectPath) });
  }
  const flows: FileBundle['flows'] = new Map();
  const cases: FileBundle['cases'] = new Map();
  const plans: FileBundle['plans'] = new Map();
  const dirEnvs = new Set<string>();

  for (const rel of listManaged(root)) {
    const text = readText(root, rel);
    const doc = parseDoc(rel, text);
    const [top] = rel.split('/');
    if (top === 'environments') {
      const parsed = EnvFileSchema.safeParse({ name: basename(rel).replace(/\.ya?ml$/i, ''), ...doc });
      if (!parsed.success) throw fileInvalid(rel, parsed.error);
      if (dirEnvs.has(parsed.data.name)) throw new S1PilotError('SYNC_DUPLICATE', `environment "${parsed.data.name}" is defined twice (${rel})`, { path: rel });
      dirEnvs.add(parsed.data.name);
      envs.set(parsed.data.name, { rel, content: toEnvContent(parsed.data, rel) });
    } else if (top === 'flows') {
      const parsed = FlowFileSchema.safeParse({ ...doc, steps: normalizeFlowSteps(doc['steps']) });
      if (!parsed.success) throw fileInvalid(rel, parsed.error);
      const name = parsed.data.name ?? basename(rel).replace(/\.ya?ml$/i, '');
      addUnique(flows, name, { rel, content: { name, params: parsed.data.params, steps: parsed.data.steps } }, 'flow', rel);
    } else if (top === 'plans') {
      const parsed = PlanFileSchema.safeParse(doc);
      if (!parsed.success) throw fileInvalid(rel, parsed.error);
      const p = parsed.data;
      addUnique(
        plans,
        p.name,
        {
          rel,
          content: {
            name: p.name,
            ...(p.release !== undefined ? { release: p.release } : {}),
            selection: p.selection,
            matrix: p.matrix.map((m) => ({ environment: m.environment, browser: m.browser, ...(m.device !== undefined ? { device: m.device } : {}) })),
            retries: p.retries,
            parallelism: p.parallelism,
            mode: p.mode,
            unattended: p.unattended,
            ...(p.schedule !== undefined ? { schedule: p.schedule } : {}),
            exitCriteria: p.exitCriteria,
            checks: p.checks,
          },
        },
        'plan',
        rel,
      );
    } else {
      const parsed = TestCaseFileSchema.safeParse({ ...doc, steps: normalizeFlowSteps(doc['steps']) });
      if (!parsed.success) throw fileInvalid(rel, parsed.error);
      const extra = CaseFileExtraSchema.safeParse(doc);
      if (!extra.success) throw fileInvalid(rel, extra.error);
      const c = parsed.data;
      if (parseCaseKey(c.key).projectKey !== pf.key) {
        throw new S1PilotError('INVALID_CASE_KEY', `${rel}: case key ${c.key} does not belong to project ${pf.key}`, { path: rel });
      }
      const suitePath = rel.split('/').slice(1, -1);
      addUnique(
        cases,
        c.key,
        {
          rel,
          content: {
            key: c.key,
            ...(extra.data.version !== undefined ? { version: extra.data.version } : {}),
            suitePath,
            title: c.title,
            priority: c.priority,
            type: c.type,
            status: c.status,
            tags: c.tags,
            requirements: c.requirements,
            ...(c.owner !== undefined ? { owner: c.owner } : {}),
            preconditions: c.preconditions,
            parameters: c.parameters,
            steps: c.steps,
          },
        },
        'case',
        rel,
      );
    }
  }

  const defaultEnvironment = pf.defaultEnvironment;
  if (defaultEnvironment !== undefined && !envs.has(defaultEnvironment)) {
    throw new S1PilotError('PROJECT_FILE_INVALID', `${projectPath}: defaultEnvironment "${defaultEnvironment}" is not defined`, { path: projectPath });
  }
  const model: ProjectModelFile | undefined = pf.model;
  return {
    project: {
      key: pf.key,
      name: pf.name,
      ...(defaultEnvironment !== undefined ? { defaultEnvironment } : {}),
      retentionDays: pf.retentionDays,
      dataPolicy: pf.dataPolicy,
      ...(model?.thresholds ? { model } : {}),
    },
    envs,
    flows,
    cases,
    plans,
  };
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

/**
 * Imports `<dir>/.s1pilot/` into the DB (the project is found, or created, by the key in
 * `project.yaml`). Returns the plan of creates/updates/conflicts/deletes; with `dryRun` nothing is
 * written. A case file whose `version` is lower than the DB version and whose content differs is a
 * conflict (reported with a unified diff, never applied). Unversioned files, or files at the DB
 * version, update the case and bump its version. DB entities without a file are only deleted with
 * `prune`.
 */
export async function importProject(db: Db, dir: string, opts: ImportOptions = {}): Promise<SyncPlan> {
  const root = syncDir(dir);
  const files = readFiles(root);
  const existing = await repos.projects.getByKey(db, files.project.key);
  const dbb = existing ? await readDb(db, existing.id) : undefined;
  const plan: SyncPlan = { creates: [], updates: [], conflicts: [], deletes: [] };
  const actions: (() => Promise<void>)[] = [];

  const projectId = existing?.id ?? newId();
  const envIdByName = new Map<string, string>([...(dbb?.envs ?? []).map((e) => [e.content.name, e.id] as const)]);
  for (const name of files.envs.keys()) if (!envIdByName.has(name)) envIdByName.set(name, newId());
  const flowIdByName = new Map<string, string>((dbb?.flows ?? []).map((f) => [f.content.name, f.id] as const));
  for (const name of files.flows.keys()) if (!flowIdByName.has(name)) flowIdByName.set(name, name);
  const caseIdByKey = new Map<string, string>((dbb?.cases ?? []).map((c) => [c.content.key, c.id] as const));
  const flowId = (name: string): string => flowIdByName.get(name) ?? name;
  const mapSteps = (steps: Step[]): Step[] =>
    steps.map((s) => (s.sharedStepId !== undefined ? { ...s, sharedStepId: flowId(s.sharedStepId) } : s));

  // Reference checks happen even on dry runs.
  const knownCaseKeys = new Set([...caseIdByKey.keys(), ...files.cases.keys()]);
  for (const { rel, content } of files.plans.values()) {
    for (const m of content.matrix) {
      if (!envIdByName.has(m.environment)) throw new S1PilotError('SYNC_REFERENCE', `${rel}: unknown environment "${m.environment}"`, { path: rel });
    }
    if (content.selection.kind === 'list') {
      for (const key of content.selection.cases) {
        if (!knownCaseKeys.has(key)) throw new S1PilotError('SYNC_REFERENCE', `${rel}: unknown case "${key}"`, { path: rel });
      }
    }
  }
  for (const { rel, content } of files.envs.values()) {
    if (content.authSetupFlow !== undefined && !flowIdByName.has(content.authSetupFlow)) {
      throw new S1PilotError('SYNC_REFERENCE', `${rel}: unknown flow "${content.authSetupFlow}"`, { path: rel });
    }
  }

  // --- project ---
  const projectChange: SyncChange = { kind: 'project', id: files.project.key, file: projectPath };
  const { defaultEnvironment: wantDefault, ...projectRest } = files.project;
  const projectPatch = {
    name: projectRest.name,
    retentionDays: projectRest.retentionDays,
    dataPolicy: projectRest.dataPolicy,
    modelSettings: projectRest.model as never,
  };
  if (!dbb) {
    plan.creates.push(projectChange);
    actions.push(async () => {
      await repos.projects.create(db, { id: projectId, key: files.project.key, ...projectPatch });
    });
  } else if (renderProject(dbb.project) !== renderProject(files.project)) {
    plan.updates.push(projectChange);
    actions.push(async () => {
      await repos.projects.update(db, projectId, projectPatch);
    });
  }

  // --- environments ---
  const dbEnvs = new Map((dbb?.envs ?? []).map((e) => [e.content.name, e] as const));
  const envInput = (c: EnvContent) => ({
    name: c.name,
    baseUrl: c.baseUrl,
    variables: c.variables,
    allowDomains: c.allowDomains,
    browsers: c.browsers,
    readOnly: c.readOnly,
    requireApprovalFor: c.requireApprovalFor,
    locale: c.locale,
    timezone: c.timezone,
  });
  for (const [name, { rel, content }] of [...files.envs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const have = dbEnvs.get(name);
    const change: SyncChange = { kind: 'environment', id: name, file: rel === projectPath ? envPath(name) : rel };
    const authFlow = content.authSetupFlow !== undefined ? { authSetupFlowId: flowId(content.authSetupFlow) } : {};
    if (!have) {
      plan.creates.push(change);
      actions.push(async () => {
        await repos.environments.create(db, { id: envIdByName.get(name) as string, projectId, ...envInput(content), ...authFlow });
      });
    } else if (renderEnv(have.content) !== renderEnv(content)) {
      plan.updates.push(change);
      actions.push(async () => {
        await repos.environments.update(db, have.id, { ...envInput(content), authSetupFlowId: authFlow.authSetupFlowId as string });
      });
    }
  }
  for (const [name, have] of dbEnvs) {
    if (files.envs.has(name)) continue;
    plan.deletes.push({ kind: 'environment', id: name, file: envPath(name) });
    if (opts.prune) actions.push(async () => repos.environments.delete(db, have.id));
  }
  if (wantDefault !== undefined && dbb?.project.defaultEnvironment !== wantDefault) {
    actions.push(async () => {
      await repos.projects.update(db, projectId, { defaultEnvironmentId: envIdByName.get(wantDefault) as string });
    });
  }

  // --- flows ---
  const dbFlows = new Map((dbb?.flows ?? []).map((f) => [f.content.name, f] as const));
  for (const [name, { rel, content }] of [...files.flows].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const have = dbFlows.get(name);
    const change: SyncChange = { kind: 'flow', id: name, file: rel };
    if (!have) {
      plan.creates.push(change);
      actions.push(async () => {
        await repos.sharedSteps.create(db, { id: flowId(name), projectId, name, params: content.params, steps: mapSteps(content.steps) });
      });
    } else if (renderFlow(have.content) !== renderFlow(content)) {
      plan.updates.push(change);
      actions.push(async () => {
        await repos.sharedSteps.update(db, have.id, { name, params: content.params, steps: mapSteps(content.steps) });
      });
    }
  }
  for (const [name, have] of dbFlows) {
    if (files.flows.has(name)) continue;
    plan.deletes.push({ kind: 'flow', id: name, file: flowPath(name) });
    if (opts.prune) actions.push(async () => repos.sharedSteps.delete(db, have.id));
  }

  // --- cases ---
  const suiteIds = new Map(dbb?.suiteIdByPath ?? []);
  const suiteIdFor = async (path: string[]): Promise<string | undefined> => {
    let parent: string | undefined;
    for (let depth = 1; depth <= path.length; depth++) {
      const key = path.slice(0, depth).join('/');
      let id = suiteIds.get(key);
      if (id === undefined) {
        const siblings = [...suiteIds.keys()].filter((k) => k.split('/').length === depth && k.startsWith(path.slice(0, depth - 1).join('/'))).length;
        const created = await repos.suites.create(db, {
          id: newId(),
          projectId,
          name: path[depth - 1] as string,
          ...(parent !== undefined ? { parentId: parent } : {}),
          position: siblings,
        });
        id = created.id;
        suiteIds.set(key, id);
      }
      parent = id;
    }
    return parent;
  };
  const caseInput = async (c: CaseContent) => {
    const suiteId = await suiteIdFor(c.suitePath);
    return {
      ...(suiteId !== undefined ? { suiteId } : {}),
      title: c.title,
      priority: c.priority,
      type: c.type,
      status: c.status,
      tags: c.tags,
      requirements: c.requirements,
      owner: c.owner,
      preconditions: c.preconditions,
      parameters: c.parameters,
      steps: mapSteps(c.steps),
    };
  };
  const dbCases = new Map((dbb?.cases ?? []).map((c) => [c.content.key, c] as const));
  for (const [key, { rel, content }] of [...files.cases].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const have = dbCases.get(key);
    if (!have) {
      plan.creates.push({ kind: 'case', id: key, file: rel });
      actions.push(async () => {
        const created = await repos.cases.createWithKey(db, projectId, key, await caseInput(content), content.version ?? 1);
        caseIdByKey.set(key, created.id);
      });
      continue;
    }
    const dbText = caseCompareText(have.content);
    const fileText = caseCompareText(content);
    if (dbText === fileText) continue;
    if (content.version !== undefined && content.version < have.version) {
      plan.conflicts.push({
        kind: 'case',
        id: key,
        file: rel,
        fileVersion: content.version,
        dbVersion: have.version,
        diff: unifiedDiff(dbText, fileText, `db/${casePath(have.content)} (v${have.version})`, `file/${rel} (v${content.version})`),
      });
      continue;
    }
    plan.updates.push({ kind: 'case', id: key, file: rel });
    actions.push(async () => {
      await repos.cases.update(db, have.id, await caseInput(content));
    });
  }
  for (const [key, have] of dbCases) {
    if (files.cases.has(key)) continue;
    plan.deletes.push({ kind: 'case', id: key, file: casePath(have.content) });
    if (opts.prune) actions.push(async () => repos.cases.delete(db, have.id));
  }

  // --- plans ---
  const dbPlans = new Map((dbb?.plans ?? []).map((p) => [p.content.name, p] as const));
  const planInput = (c: PlanContent) => ({
    name: c.name,
    ...(c.release !== undefined ? { release: c.release } : {}),
    selection:
      c.selection.kind === 'list'
        ? { kind: 'list' as const, caseIds: c.selection.cases.map((k) => caseIdByKey.get(k) as string) }
        : c.selection,
    matrix: c.matrix.map((m) => ({
      environmentId: envIdByName.get(m.environment) as string,
      browser: m.browser,
      ...(m.device !== undefined ? { device: m.device } : {}),
    })),
    retries: c.retries,
    parallelism: c.parallelism,
    mode: c.mode,
    unattended: c.unattended,
    schedule: c.schedule,
    exitCriteria: c.exitCriteria,
    checks: c.checks,
  });
  for (const [name, { rel, content }] of [...files.plans].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const have = dbPlans.get(name);
    if (!have) {
      plan.creates.push({ kind: 'plan', id: name, file: rel });
      actions.push(async () => {
        await repos.plans.create(db, { id: newId(), projectId, ...planInput(content) });
      });
    } else if (renderPlan(have.content) !== renderPlan(content)) {
      plan.updates.push({ kind: 'plan', id: name, file: rel });
      actions.push(async () => {
        await repos.plans.update(db, have.id, { ...planInput(content), release: content.release });
      });
    }
  }
  for (const [name, have] of dbPlans) {
    if (files.plans.has(name)) continue;
    plan.deletes.push({ kind: 'plan', id: name, file: planPath(name) });
    if (opts.prune) actions.push(async () => repos.plans.delete(db, have.id));
  }

  if (!opts.dryRun) {
    for (const action of actions) await action();
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/**
 * Compares the DB with `<dir>/.s1pilot/`. `'clean'` means a fresh export would not change any file
 * and an import would change nothing; otherwise lists the differing files (changed, missing or
 * stale) and any version conflicts. Used for "Synced with .s1pilot/ in git · clean".
 */
export async function syncStatus(db: Db, projectId: string, dir: string): Promise<'clean' | SyncDirty> {
  const root = syncDir(dir);
  const rendered = renderBundle(await readDb(db, projectId));
  const changed = new Set<string>();
  for (const [rel, text] of rendered) {
    const abs = join(root, rel);
    if (!existsSync(abs) || !statSync(abs).isFile() || readFileSync(abs, 'utf8') !== text) changed.add(rel);
  }
  for (const rel of listManaged(root)) if (!rendered.has(rel)) changed.add(rel);

  let conflicts: SyncConflict[] = [];
  if (existsSync(join(root, PROJECT_FILE))) {
    try {
      conflicts = (await importProject(db, root, { dryRun: true })).conflicts;
    } catch {
      // Unreadable files are already reported as changed.
    }
  }
  if (changed.size === 0 && conflicts.length === 0) return 'clean';
  return { changedFiles: [...changed].sort(), conflicts };
}
