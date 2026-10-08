import { statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { openDb, repos, type Db } from '@s1pilot/db';
import {
  EnvironmentSchema,
  ExecutionModeSchema,
  ModelEndpointSchema,
  S1PilotError,
  ThresholdsSchema,
  createRedactor,
  newId,
  type BrowserName,
  type DecisionModel,
  type Environment,
  type ExecutionMode,
  type ModelEndpoint,
  type Redactor,
  type TestCase,
  type Thresholds,
  type Verdict,
} from '@s1pilot/domain';
import { createReadlineHumanHook, type HealProposalDraft } from '@s1pilot/engine';
import {
  MockDecisionModel,
  createChatModel,
  createDecisionModel,
  loadMockScript,
  loadProfile,
  mockResolver,
  type ChatModel,
} from '@s1pilot/providers';
import { parseReporterList, writeReports, type ReporterName } from '@s1pilot/reporters';
import { runCases, type RunnerEvent } from '@s1pilot/runner';
import {
  FsLearnedScriptStore,
  PROJECT_DIR,
  PROJECT_FILE,
  findProjectRoot,
  flowLookup,
  loadDataset,
  listYamlFiles,
  loadCaseFile,
  loadProjectDir,
  loadProjectFile,
  type LoadedProject,
  type ProjectModelFile,
} from '@s1pilot/sync';
import { chromium, firefox, webkit, type Browser } from 'playwright';


/** Exit codes of `s1pilot run`. */
export const EXIT_PASSED = 0;
export const EXIT_FAILED = 1;
export const EXIT_NEEDS_REVIEW = 2;
export const EXIT_CONFIG = 3;

/** Options of `s1pilot run` (commander camel-cases the flags). */
export interface RunOptions {
  env?: string;
  modelUrl?: string;
  model?: string;
  adapter?: string;
  profile?: string;
  key?: string;
  s2Url?: string;
  s2Model?: string;
  headed?: boolean;
  attended?: boolean;
  browser: BrowserName;
  out: string;
  project?: string;
  baseUrl?: string;
  mockScript?: string;
  /** `replay-heal` (default), `explore` or `replay-only`. */
  mode?: ExecutionMode;
  /** Comma-separated reporters: `junit`, `json`, `html`. */
  reporter?: string;
  /** Cases to run at the same time (default 1). */
  parallel?: number;
}

/** The slice of `CliDeps` that `run` needs. */
export interface RunDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

const DEFAULT_THRESHOLDS: Thresholds = { act: 0.8, pass: 0.9, fail: 0.1, escalate: 0.4 };

/** A problem with the user's setup (exit code 3), as opposed to a failing test. */
class ConfigError extends Error {}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolves an `env:NAME` reference from the process environment; other forms are config errors. */
function resolveEnvRef(ref: string, env: NodeJS.ProcessEnv, what: string): string {
  if (!ref.startsWith('env:')) {
    throw new ConfigError(`${what}: only "env:NAME" references are supported by the CLI (got "${ref.split(':')[0] ?? ''}:...")`);
  }
  const name = ref.slice('env:'.length);
  const value = env[name];
  if (!value) throw new ConfigError(`${what}: environment variable ${name} is not set`);
  return value;
}

interface Resolved {
  environment: Environment;
  cases: TestCase[];
  /** Project root (directory holding `.s1pilot/`), when found. */
  root?: string;
  project?: LoadedProject | Omit<LoadedProject, 'cases'>;
}

function resolveProjectAndCases(target: string, opts: RunOptions): Resolved {
  const absolute = resolve(target);
  if (!exists(absolute)) throw new ConfigError(`Not found: ${target}`);
  const root = opts.project ? resolve(opts.project) : findProjectRoot(absolute);
  if (opts.project && !exists(join(root ?? '', PROJECT_DIR, PROJECT_FILE))) {
    throw new ConfigError(`No ${PROJECT_DIR}/${PROJECT_FILE} in ${opts.project}`);
  }
  const loaded = root ? loadProjectFile(root) : undefined;

  let cases: TestCase[];
  const projectId = loaded?.project.id;
  if (!isDir(absolute)) {
    cases = [loadCaseFile(absolute, projectId ? { projectId } : {})];
  } else if (exists(join(absolute, PROJECT_DIR, PROJECT_FILE))) {
    cases = loadProjectDir(absolute).cases;
  } else {
    cases = listYamlFiles(absolute).map((f) => loadCaseFile(f, projectId ? { projectId } : {}));
  }
  if (cases.length === 0) throw new ConfigError(`No test case files found in ${target}`);

  let environment: Environment | undefined;
  if (loaded && loaded.environments.length > 0) {
    const name = opts.env ?? loaded.environments.find((e) => e.id === loaded.project.defaultEnvironmentId)?.name;
    if (name === undefined && loaded.environments.length === 1) environment = loaded.environments[0];
    else if (name === undefined) {
      throw new ConfigError(`Choose an environment with --env (${loaded.environments.map((e) => e.name).join(', ')})`);
    } else {
      environment = loaded.environments.find((e) => e.name === name);
      if (!environment) {
        throw new ConfigError(`Unknown environment "${name}"; the project defines: ${loaded.environments.map((e) => e.name).join(', ')}`);
      }
    }
  }
  if (!environment) {
    if (!opts.baseUrl) {
      throw new ConfigError(
        `No environment found. Add one to ${PROJECT_DIR}/${PROJECT_FILE} (searched upwards from ${target}) or pass --base-url <url>.`,
      );
    }
    environment = EnvironmentSchema.parse({ id: newId(), projectId: projectId ?? newId(), name: opts.env ?? 'adhoc', baseUrl: opts.baseUrl });
  } else if (opts.baseUrl) {
    environment = { ...environment, baseUrl: opts.baseUrl };
  }
  try {
    new URL(environment.baseUrl);
  } catch {
    throw new ConfigError(`Environment "${environment.name}" has an invalid base URL: ${environment.baseUrl}`);
  }
  return { environment, cases, ...(root ? { root } : {}), ...(loaded ? { project: loaded } : {}) };
}

interface Vars {
  keys(): string[];
  isSecret(key: string): boolean;
  secretValues(): string[];
  get(key: string): string | undefined;
}

/** Resolves environment variables; secrets only from the process environment (`env:` refs). */
function resolveVars(environment: Environment, env: NodeJS.ProcessEnv): Vars {
  const values = new Map<string, { value: string; secret: boolean }>();
  for (const v of environment.variables) {
    let value: string | undefined;
    if (v.source === 'env') {
      value = v.envVar === undefined ? undefined : env[v.envVar];
      if (value === undefined) throw new ConfigError(`Variable "${v.key}": environment variable ${v.envVar ?? '?'} is not set`);
    } else {
      if (v.secret) {
        throw new ConfigError(`Variable "${v.key}" is secret; reference it as "env:NAME" instead of writing the value in YAML`);
      }
      value = v.value ?? '';
    }
    values.set(v.key, { value, secret: v.secret });
  }
  return {
    keys: () => [...values.keys()],
    isSecret: (k) => values.get(k)?.secret === true,
    secretValues: () => [...values.values()].filter((e) => e.secret).map((e) => e.value),
    get: (k) => values.get(k)?.value,
  };
}

interface Models {
  s1: DecisionModel;
  s2?: ChatModel;
  thresholds: Thresholds;
  modelName: string;
}

function resolveModels(opts: RunOptions, file: ProjectModelFile | undefined, env: NodeJS.ProcessEnv, redactor: Redactor): Models {
  const adapter = opts.adapter ?? file?.system1.adapter;
  if (adapter === undefined) {
    throw new ConfigError(
      [
        'No System 1 model configured.',
        'Pass --adapter <systemone|decide|openai-logprobs|mock> --model-url <url> --model <name>,',
        `or add a "model: { system1: ... }" block to ${PROJECT_DIR}/${PROJECT_FILE}.`,
        'Run `s1pilot probe --url <url>` to detect the adapter and capabilities of an endpoint.',
      ].join('\n'),
    );
  }
  const raw = {
    adapter,
    ...(opts.modelUrl ?? file?.system1.baseUrl ? { baseUrl: opts.modelUrl ?? file?.system1.baseUrl } : {}),
    model: opts.model ?? file?.system1.model ?? (adapter === 'mock' ? 'mock' : undefined),
    ...(file?.system1.apiKeyRef ? { apiKeyRef: file.system1.apiKeyRef } : {}),
    ...(opts.profile ?? file?.system1.profileId ? { profileId: opts.profile ?? file?.system1.profileId } : {}),
  };
  const parsed = ModelEndpointSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid System 1 model settings: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'model'}: ${i.message}`).join('; ')}`);
  }
  const endpoint: ModelEndpoint = parsed.data;
  let profile;
  if (endpoint.profileId !== undefined) {
    try {
      profile = loadProfile(endpoint.profileId);
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : String(error));
    }
  }
  const thresholds = ThresholdsSchema.parse(file?.thresholds ?? profile?.thresholds ?? DEFAULT_THRESHOLDS);

  const apiKey = opts.key ?? env['S1PILOT_API_KEY'] ?? (endpoint.apiKeyRef ? resolveEnvRef(endpoint.apiKeyRef, env, 'System 1 apiKeyRef') : undefined);
  const modelOptions = {
    ...(apiKey ? { apiKey } : {}),
    redactor,
  };
  let s1: DecisionModel;
  if (opts.mockScript !== undefined) {
    if (endpoint.adapter !== 'mock') throw new ConfigError('--mock-script requires --adapter mock');
    s1 = createDecisionModel(endpoint, {
      ...modelOptions,
      mock: new MockDecisionModel({ fallback: mockResolver(loadMockScript(opts.mockScript)) }),
    });
  } else {
    s1 = createDecisionModel(endpoint, modelOptions);
  }

  let s2: ChatModel | undefined;
  const s2Raw =
    opts.s2Url !== undefined || opts.s2Model !== undefined
      ? {
          adapter: 'openai-chat',
          ...(opts.s2Url ?? file?.system2?.baseUrl ? { baseUrl: opts.s2Url ?? file?.system2?.baseUrl } : {}),
          model: opts.s2Model ?? file?.system2?.model,
          ...(file?.system2?.apiKeyRef ? { apiKeyRef: file.system2.apiKeyRef } : {}),
        }
      : file?.system2;
  if (s2Raw) {
    const p2 = ModelEndpointSchema.safeParse(s2Raw);
    if (!p2.success) {
      throw new ConfigError(`Invalid System 2 model settings: ${p2.error.issues.map((i) => `${i.path.join('.') || 'model'}: ${i.message}`).join('; ')}`);
    }
    const key2 = env['S1PILOT_S2_API_KEY'] ?? (p2.data.apiKeyRef ? resolveEnvRef(p2.data.apiKeyRef, env, 'System 2 apiKeyRef') : undefined);
    s2 = createChatModel(p2.data, { ...(key2 ? { apiKey: key2 } : {}), redactor });
  }
  return { s1, ...(s2 ? { s2 } : {}), thresholds, modelName: endpoint.model };
}

const ICONS: Record<Verdict, string> = {
  passed: '✓',
  failed: '✗',
  blocked: '⊘',
  skipped: '-',
  flaky: '~',
  'needs-review': '!',
};

function shorten(text: string, max = 44): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function exitCodeFor(verdicts: Verdict[]): number {
  if (verdicts.some((v) => v === 'failed' || v === 'blocked' || v === 'flaky')) return EXIT_FAILED;
  if (verdicts.some((v) => v === 'needs-review')) return EXIT_NEEDS_REVIEW;
  return EXIT_PASSED;
}

const LAUNCHERS = { chromium, firefox, webkit } as const;

/**
 * Heal proposals go to the project database (`.s1pilot/data.db`) when it exists and knows the
 * case; otherwise they are written as JSON below `.s1pilot/heal-proposals/` so nothing is lost.
 */
function createHealProposalStore(root: string): { create(draft: HealProposalDraft): Promise<unknown>; close(): void } {
  let db: Db | undefined;
  const dbPath = join(root, PROJECT_DIR, 'data.db');
  return {
    async create(draft) {
      if (exists(dbPath)) {
        try {
          db ??= openDb({ url: dbPath });
          return await repos.healProposals.create(db, draft);
        } catch {
          // The case is not synced into the database (yet): keep the proposal as a file.
        }
      }
      const dir = join(root, PROJECT_DIR, 'heal-proposals');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${draft.id}.json`), `${JSON.stringify({ ...draft, status: 'pending' }, null, 2)}\n`);
      return undefined;
    },
    close: () => db?.close(),
  };
}

/** Formats runner events as the terminal output of `s1pilot run`; buffers per case when cases run in parallel. */
function createPrinter(say: (line: string) => void, redact: (s: string) => string, parallel: boolean): (event: RunnerEvent) => void {
  const buffers = new Map<string, string[]>();
  const rowLabels = new Map<string, string>();
  const out = (id: string, line: string): void => {
    if (!parallel) say(line);
    else buffers.set(id, [...(buffers.get(id) ?? []), line]);
  };
  return (event) => {
    switch (event.type) {
      case 'case.started':
        rowLabels.set(event.caseResultId, event.label ? ` [${event.label}]` : '');
        out(event.caseResultId, '');
        out(event.caseResultId, `${event.key} · ${event.title}${rowLabels.get(event.caseResultId) ?? ''}`);
        break;
      case 'note':
        out(event.caseResultId, `  ${event.text}`);
        break;
      case 'step.finished': {
        const s = event.step;
        const id = event.caseResultId;
        if (s.verdict === 'skipped') {
          out(id, `  ${ICONS.skipped} ${s.index + 1} · ${shorten(s.action)} (skipped)`);
          break;
        }
        out(
          id,
          `  ${ICONS[s.verdict]} ${s.index + 1} · ${s.phase === 'precondition' ? '[precondition] ' : ''}${shorten(s.action)} (${s.mode ?? 'explore'}, ${s.actions} action${s.actions === 1 ? '' : 's'}, ${seconds(s.durationMs)})`,
        );
        if (s.verdict !== 'passed') {
          if (s.reason) out(id, `      ${redact(s.reason)}`);
          for (const a of s.assertions.filter((x) => x.verdict !== 'pass')) out(id, `      ${a.verdict}: ${redact(a.message ?? a.assertion)}`);
        }
        break;
      }
      case 'case.finished': {
        out(event.caseResultId, `  ${ICONS[event.result.verdict]} ${event.result.verdict} in ${seconds(event.result.durationMs)}`);
        if (event.result.healProposals > 0) {
          out(event.caseResultId, `  ${event.result.healProposals} heal proposal${event.result.healProposals === 1 ? '' : 's'} pending review`);
        }
        const lines = buffers.get(event.caseResultId);
        if (lines) {
          for (const line of lines) say(line);
          buffers.delete(event.caseResultId);
        }
        break;
      }
      default:
        break;
    }
  };
}

/**
 * Runs YAML test cases via `runCases` and returns the process exit code:
 * 0 all passed, 1 a case failed or was blocked, 2 only needs-review, 3 configuration error.
 * Writes `<out>/<case>/trace.jsonl` + `result.json` per case row, `<out>/summary.json` and the
 * `--reporter` files (`junit.xml`, `report.json`).
 */
export async function executeRun(target: string, opts: RunOptions, deps: RunDeps): Promise<number> {
  const say = (line: string): void => deps.stdout(`${line}\n`);
  let browser: Browser | undefined;
  let healStore: ReturnType<typeof createHealProposalStore> | undefined;
  try {
    const mode = opts.mode ?? 'replay-heal';
    if (!ExecutionModeSchema.safeParse(mode).success) {
      throw new ConfigError(`Unknown --mode "${mode}"; use replay-heal, explore or replay-only`);
    }
    const parallel = opts.parallel ?? 1;
    if (!Number.isInteger(parallel) || parallel < 1) throw new ConfigError('--parallel must be a whole number of at least 1');
    let reporters: ReporterName[] = [];
    try {
      reporters = opts.reporter ? parseReporterList(opts.reporter) : [];
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : String(error));
    }

    const resolved = resolveProjectAndCases(target, opts);
    const { environment, cases } = resolved;
    const vars = resolveVars(environment, deps.env);
    const redactor = createRedactor({
      secrets: vars.secretValues(),
      patterns: resolved.project?.project.dataPolicy.redactPatterns ?? [],
    });
    const models = resolveModels(opts, resolved.project?.model, deps.env, redactor);
    const outDir = resolve(opts.out);
    try {
      browser = await LAUNCHERS[opts.browser].launch({ headless: opts.headed !== true });
    } catch (error) {
      throw new ConfigError(
        `Could not launch ${opts.browser}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\nInstall it with: npx playwright install ${opts.browser}`,
      );
    }
    const human = opts.attended ? createReadlineHumanHook() : undefined;

    say(`s1pilot run  env ${environment.name} (${redactor.redact(environment.baseUrl)})  browser ${opts.browser}  model ${models.modelName}  mode ${mode}`);
    const root = resolved.root;
    const flows = root ? flowLookup(root, resolved.project?.project.id) : () => undefined;
    const datasets = (name: string) => (root ? loadDataset(root, name, environment.name) : undefined);
    const projectRoot = resolved.project?.root;
    if (projectRoot !== undefined) healStore = createHealProposalStore(projectRoot);
    const projectKey = resolved.project?.project.key;

    const report = await runCases({
      cases,
      environment,
      browser,
      browserName: opts.browser,
      mode,
      models,
      stores: {
        ...(projectRoot !== undefined ? { scripts: new FsLearnedScriptStore(projectRoot) } : {}),
        ...(healStore ? { healProposals: healStore } : {}),
      },
      emit: createPrinter(say, (s) => redactor.redact(s), parallel > 1),
      ...(human ? { human, attended: true } : {}),
      out: outDir,
      parallelism: parallel,
      vars,
      redactor,
      flows,
      datasets,
      ...(projectKey ? { suiteOf: (c) => c.suiteId ?? projectKey } : {}),
    });

    const counts = report.totals;
    say('');
    say(`Cases: ${counts.passed} passed, ${counts.failed} failed, ${counts.blocked} blocked, ${counts.needsReview} needs review (${report.cases.length} total)`);
    say(`Step success rate: ${report.steps.passed}/${report.steps.executed} (${(report.steps.successRate * 100).toFixed(0)}%)`);
    say(`Results: ${outDir}`);
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, 'summary.json'),
      `${JSON.stringify(
        {
          runId: report.runId,
          environment: environment.name,
          cases: report.cases.map((c) => ({ key: c.key, row: c.row, label: c.label ?? '', verdict: c.verdict, mode: c.mode, dir: c.dir })),
          steps: report.steps,
        },
        null,
        2,
      )}\n`,
    );
    for (const file of await writeReports(report, outDir, reporters, {}, { redactor })) say(`Report: ${file}`);
    return exitCodeFor(report.cases.map((c) => c.verdict));
  } catch (error) {
    if (error instanceof ConfigError || error instanceof S1PilotError) {
      deps.stderr(`error: ${error.message}\n`);
      return EXIT_CONFIG;
    }
    throw error;
  } finally {
    healStore?.close();
    await browser?.close();
  }
}
