import { statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  EnvironmentSchema,
  ModelEndpointSchema,
  S1PilotError,
  ThresholdsSchema,
  createRedactor,
  newId,
  type AssertionVerdict,
  type BrowserName,
  type DecisionModel,
  type DecisionRecord,
  type Environment,
  type ModelEndpoint,
  type Redactor,
  type TestCase,
  type Thresholds,
  type Verdict,
} from '@s1pilot/domain';
import {
  StepCapture,
  caseVerdict,
  createJsonlTraceWriter,
  createReadlineHumanHook,
  exploreStep,
  installDomainGuard,
  installReadOnlyGuard,
  verifyStep,
  type EngineContext,
  type InstalledGuard,
} from '@s1pilot/engine';
import {
  MockDecisionModel,
  createChatModel,
  createDecisionModel,
  loadProfile,
  type ChatModel,
} from '@s1pilot/providers';
import {
  PROJECT_DIR,
  PROJECT_FILE,
  findProjectRoot,
  listYamlFiles,
  loadCaseFile,
  loadProjectDir,
  loadProjectFile,
  type LoadedProject,
  type ProjectModelFile,
} from '@s1pilot/sync';
import { chromium, firefox, webkit, type Browser } from 'playwright';

import { loadMockScript, mockResolver } from './mock-script.js';

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
  return { environment, cases, ...(loaded ? { project: loaded } : {}) };
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

/** Result of one case row. */
interface CaseOutcome {
  verdict: Verdict;
  steps: { verdict: Verdict; executed: boolean }[];
}

const ICONS: Record<Verdict, string> = {
  passed: '✓',
  failed: '✗',
  blocked: '⊘',
  skipped: '-',
  flaky: '~',
  'needs-review': '!',
};

function bind(text: string, params: Record<string, string>): string {
  return text.replace(/\{([\w.-]+)\}/g, (whole, name: string) => params[name] ?? whole);
}

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
 * Runs YAML test cases in Explore mode and returns the process exit code:
 * 0 all passed, 1 a case failed or was blocked, 2 only needs-review, 3 configuration error.
 * Writes `<out>/<case>/trace.jsonl` + `result.json` per case row and `<out>/summary.json`.
 */
export async function executeRun(target: string, opts: RunOptions, deps: RunDeps): Promise<number> {
  const say = (line: string): void => deps.stdout(`${line}\n`);
  let browser: Browser | undefined;
  try {
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

    say(`s1pilot run  env ${environment.name} (${redactor.redact(environment.baseUrl)})  browser ${opts.browser}  model ${models.modelName}`);
    const runId = newId();
    const outcomes: CaseOutcome[] = [];
    const summaryCases: { key: string; row: number; verdict: Verdict; dir: string }[] = [];

    for (const testCase of cases) {
      const rows = testCase.parameters.length > 0 ? testCase.parameters : [{}];
      for (const [rowIndex, row] of rows.entries()) {
        const params = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, String(v)]));
        const dirName = `${testCase.key.replace(/[^\w.-]+/g, '_')}${rows.length > 1 ? `-${rowIndex + 1}` : ''}`;
        const caseDir = join(outDir, dirName);
        const outcome = await runCase({
          testCase,
          params,
          rowLabel: rows.length > 1 ? ` [row ${rowIndex + 1}/${rows.length}]` : '',
          caseDir,
          browser,
          environment,
          vars,
          redactor,
          models,
          human,
          runId,
          browserName: opts.browser,
          say,
        });
        outcomes.push(outcome);
        summaryCases.push({ key: testCase.key, row: rowIndex + 1, verdict: outcome.verdict, dir: dirName });
      }
    }

    const executed = outcomes.flatMap((o) => o.steps).filter((s) => s.executed);
    const okSteps = executed.filter((s) => s.verdict === 'passed').length;
    const rate = executed.length === 0 ? 0 : okSteps / executed.length;
    const counts = (v: Verdict): number => outcomes.filter((o) => o.verdict === v).length;
    say('');
    say(
      `Cases: ${counts('passed')} passed, ${counts('failed')} failed, ${counts('blocked')} blocked, ${counts('needs-review')} needs review (${outcomes.length} total)`,
    );
    say(`Step success rate: ${okSteps}/${executed.length} (${(rate * 100).toFixed(0)}%)`);
    say(`Results: ${outDir}`);
    await mkdir(outDir, { recursive: true });
    await writeFile(
      join(outDir, 'summary.json'),
      `${JSON.stringify({ runId, environment: environment.name, cases: summaryCases, steps: { executed: executed.length, passed: okSteps, successRate: rate } }, null, 2)}\n`,
    );
    return exitCodeFor(outcomes.map((o) => o.verdict));
  } catch (error) {
    if (error instanceof ConfigError || error instanceof S1PilotError) {
      deps.stderr(`error: ${error.message}\n`);
      return EXIT_CONFIG;
    }
    throw error;
  } finally {
    await browser?.close();
  }
}

interface CaseRun {
  testCase: TestCase;
  params: Record<string, string>;
  rowLabel: string;
  caseDir: string;
  browser: Browser;
  environment: Environment;
  vars: Vars;
  redactor: Redactor;
  models: Models;
  human: ReturnType<typeof createReadlineHumanHook> | undefined;
  runId: string;
  browserName: BrowserName;
  say: (line: string) => void;
}

interface StepRecord {
  index: number;
  action: string;
  verdict: Verdict;
  ended?: string;
  reason?: string;
  actionTaken?: string;
  actions: number;
  iterations: number;
  durationMs: number;
  assertions: AssertionVerdict[];
  decisions: DecisionRecord[];
}

async function runCase(run: CaseRun): Promise<CaseOutcome> {
  const { testCase, params, environment, redactor, say } = run;
  const r = (s: string): string => redactor.redact(s);
  const startedAt = new Date();
  const caseResultId = newId();
  const tracePath = join(run.caseDir, 'trace.jsonl');
  await mkdir(run.caseDir, { recursive: true });
  await rm(tracePath, { force: true });
  const trace = createJsonlTraceWriter(tracePath);

  say('');
  say(`${testCase.key} · ${r(testCase.title)}${run.rowLabel}`);
  if (testCase.preconditions.length > 0) {
    // TODO(S-026): preconditions (flows, auth) are applied by the case runner.
    say('  ! preconditions are not applied in explore mode yet');
  }

  const context = await run.browser.newContext({ locale: environment.locale, timezoneId: environment.timezone });
  const guards: InstalledGuard[] = [];
  const onEvent = (e: { method?: string; url?: string; reason: string }): void => {
    say(`  ! blocked ${e.method ?? ''} ${r(e.url ?? '')}: ${e.reason}`.replace(/\s+/g, ' '));
  };
  guards.push(await installDomainGuard(context, { baseUrl: environment.baseUrl, allowDomains: environment.allowDomains, onEvent }));
  if (environment.readOnly) guards.push(await installReadOnlyGuard(context, { onEvent }));
  const page = await context.newPage();

  const steps: StepRecord[] = [];
  const outcomeSteps: CaseOutcome['steps'] = [];
  const ctx: EngineContext = {
    page,
    s1: run.models.s1,
    ...(run.models.s2 ? { s2: run.models.s2 } : {}),
    ...(run.human ? { human: run.human, attended: true } : {}),
    vars: run.vars,
    params,
    environment,
    thresholds: run.models.thresholds,
    caps: run.models.s1.capabilities,
    redactor,
    emit: () => undefined,
    trace,
    budgets: {},
    runId: run.runId,
    caseResultId,
    modelName: run.models.modelName,
  };

  let stop: Verdict | undefined;
  try {
    try {
      await page.goto(environment.baseUrl);
    } catch (error) {
      stop = 'blocked';
      steps.push({
        index: 0,
        action: `Open ${environment.baseUrl}`,
        verdict: 'blocked',
        reason: r(`Could not open ${environment.baseUrl}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`),
        actions: 0,
        iterations: 0,
        durationMs: 0,
        assertions: [],
        decisions: [],
      });
      say(`  ${ICONS.blocked} could not open ${r(environment.baseUrl)}`);
    }

    for (const [index, step] of testCase.steps.entries()) {
      const action = bind(step.action, params);
      if (stop !== undefined) {
        steps.push({ index, action: r(action), verdict: 'skipped', actions: 0, iterations: 0, durationMs: 0, assertions: [], decisions: [] });
        outcomeSteps.push({ verdict: 'skipped', executed: false });
        say(`  ${ICONS.skipped} ${index + 1} · ${shorten(r(action))} (skipped)`);
        continue;
      }
      const capture = StepCapture.start(ctx.page);
      let record: StepRecord;
      try {
        const exec = await exploreStep(ctx, { index, action: step.action, inputs: step.inputs });
        const verification = await verifyStep(
          { page: ctx.page, s1: ctx.s1, thresholds: ctx.thresholds, redactor, modelName: run.models.modelName },
          {
            ...(step.expected ? { expected: bind(step.expected, params) } : {}),
            assertions: step.assert,
            priority: testCase.priority,
            capture,
            executionStatus: exec.status,
          },
        );
        record = {
          index,
          action: r(action),
          verdict: verification.verdict,
          ended: exec.ended,
          ...(exec.reason ? { reason: exec.reason } : {}),
          ...(exec.actionTaken ? { actionTaken: r(exec.actionTaken) } : {}),
          actions: exec.actions.length,
          iterations: exec.iterations,
          durationMs: exec.durationMs,
          assertions: verification.stepAssertions,
          decisions: [...exec.decisions, ...verification.decisions],
        };
      } catch (error) {
        record = {
          index,
          action: r(action),
          verdict: 'failed',
          ended: 'error',
          reason: r(error instanceof Error ? error.message : String(error)),
          actions: 0,
          iterations: 0,
          durationMs: 0,
          assertions: [],
          decisions: [],
        };
      } finally {
        capture.dispose();
      }
      steps.push(record);
      outcomeSteps.push({ verdict: record.verdict, executed: true });
      say(`  ${ICONS[record.verdict]} ${index + 1} · ${shorten(r(action))} (explore, ${record.actions} action${record.actions === 1 ? '' : 's'}, ${seconds(record.durationMs)})`);
      if (record.verdict !== 'passed') {
        if (record.reason) say(`      ${r(record.reason)}`);
        for (const a of record.assertions.filter((x) => x.verdict !== 'pass')) say(`      ${a.verdict}: ${r(a.message ?? a.assertion)}`);
      }
      if (record.verdict === 'failed' || record.verdict === 'blocked') stop = record.verdict;
    }
  } finally {
    for (const g of guards) await g.dispose();
    await trace.close?.();
    await context.close();
  }

  const verdict = caseVerdict(steps.map((s) => s.verdict));
  const durationMs = Date.now() - startedAt.getTime();
  const result = {
    runId: run.runId,
    caseResultId,
    key: testCase.key,
    title: testCase.title,
    priority: testCase.priority,
    mode: 'explore',
    verdict,
    environment: environment.name,
    browser: run.browserName,
    params,
    startedAt: startedAt.toISOString(),
    durationMs,
    steps,
  };
  await writeFile(join(run.caseDir, 'result.json'), `${JSON.stringify(redactor.redactDeep(result), null, 2)}\n`);
  say(`  ${ICONS[verdict]} ${verdict} in ${seconds(durationMs)}`);
  return { verdict, steps: outcomeSteps };
}
