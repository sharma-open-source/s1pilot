import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { RunReportSchema, S1PilotError, type RunReport } from '@s1pilot/domain';
import { loadProfile } from '@s1pilot/providers';
import type { Command } from 'commander';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

import type { CliDeps } from './program.js';
import { executeRun, type RunOptions } from './run.js';

/** Expected verdict of an eval entry. */
const ExpectedVerdictSchema = z.enum(['passed', 'failed']);

/** `suites/<name>/suite.yaml`: which cases to run against which fixture bug/variant sets, and the correct verdicts. */
export const EvalSuiteSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  /** Origin of the fixture server, e.g. `http://127.0.0.1:4400`. */
  baseUrl: z.string().url(),
  /** Variables of the generated eval environment (no secrets). */
  variables: z.record(z.string()).default({}),
  cases: z
    .array(
      z.object({
        key: z.string().min(1),
        /** Case YAML, relative to the suite file. */
        file: z.string().min(1),
        /** Site path below `baseUrl`, e.g. `/shop`. */
        site: z.string().startsWith('/'),
        /** Mock script used by oracle mode, relative to the suite file. */
        mockScript: z.string().optional(),
        /** Case key in `fixtures/sites/ground-truth.json` the expectations derive from. */
        groundTruth: z.string().optional(),
      }),
    )
    .min(1),
  runs: z
    .array(
      z.object({
        case: z.string().min(1),
        bugs: z.array(z.string()).default([]),
        variants: z.array(z.string()).default([]),
        verdict: ExpectedVerdictSchema,
      }),
    )
    .min(1),
});
export type EvalSuite = z.infer<typeof EvalSuiteSchema>;

/** One executed run of the harness. */
export interface EvalRunRecord {
  model: string;
  profile: string | null;
  engineSha: string;
  case: string;
  bugs: string[];
  variants: string[];
  repeat: number;
  /** `learn` (clean explore that records the script; not scored), `explore` or `replay`. */
  phase: 'learn' | 'explore' | 'replay';
  expected: 'passed' | 'failed';
  verdict: string;
  /** Verdict equals the expectation (a variant that must heal also needs a healed step). */
  correct: boolean;
  expectHealing: boolean;
  healed: boolean;
  stepsExecuted: number;
  stepsPassed: number;
  replayedSteps: number;
  replayStepsExecuted: number;
  latenciesMs: number[];
  escalations: number;
  dir: string;
}

/** Metrics of one model; `null` when no run was applicable (for example no seeded bugs in the suite). */
export interface EvalMetrics {
  runs: number;
  stepSuccessRate: number | null;
  bugDetectionRate: number | null;
  falseFailRate: number | null;
  falsePassRate: number | null;
  needsReviewRate: number | null;
  healSuccessRate: number | null;
  replayHitRate: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  escalations: number;
}

/** Contents of `summary.json`. */
export interface EvalSummary {
  version: 1;
  suite: string;
  mode: 'oracle' | 'live';
  startedAt: string;
  finishedAt: string;
  repeat: number;
  engine: { gitSha: string };
  models: { id: string; profile: string | null; adapter: string; metrics: EvalMetrics }[];
  runs: EvalRunRecord[];
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

/** Nearest-rank percentile (`p` in 0..100) of unsorted values. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/**
 * Computes the plan section 14 metrics from run records of one model. Only `explore` and `replay`
 * runs are scored (`learn` runs just record the script):
 * - bug detection: runs with a seeded bug that failed; false-pass: those that passed;
 * - false-fail: runs expected to pass that failed or blocked;
 * - heal success: healing-expected runs that passed with at least one healed step;
 * - replay hit rate: replay-phase steps performed by the learned script as recorded.
 */
export function computeMetrics(records: EvalRunRecord[]): EvalMetrics {
  const scored = records.filter((r) => r.phase !== 'learn');
  const buggy = scored.filter((r) => r.bugs.length > 0);
  const shouldPass = scored.filter((r) => r.expected === 'passed');
  const healing = scored.filter((r) => r.expectHealing && r.phase === 'replay');
  const replay = scored.filter((r) => r.phase === 'replay');
  const latencies = scored.flatMap((r) => r.latenciesMs);
  const executed = scored.reduce((n, r) => n + r.stepsExecuted, 0);
  return {
    runs: scored.length,
    stepSuccessRate: ratio(
      scored.reduce((n, r) => n + r.stepsPassed, 0),
      executed,
    ),
    bugDetectionRate: ratio(buggy.filter((r) => r.verdict === 'failed').length, buggy.length),
    falseFailRate: ratio(shouldPass.filter((r) => r.verdict === 'failed' || r.verdict === 'blocked').length, shouldPass.length),
    falsePassRate: ratio(buggy.filter((r) => r.verdict === 'passed').length, buggy.length),
    needsReviewRate: ratio(scored.filter((r) => r.verdict === 'needs-review').length, scored.length),
    healSuccessRate: ratio(healing.filter((r) => r.verdict === 'passed' && r.healed).length, healing.length),
    replayHitRate: ratio(
      replay.reduce((n, r) => n + r.replayedSteps, 0),
      replay.reduce((n, r) => n + r.replayStepsExecuted, 0),
    ),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    escalations: scored.reduce((n, r) => n + r.escalations, 0),
  };
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}
function ms(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value)} ms`;
}

/** Renders the leaderboard: one row per model, one column per metric, plus model/profile/engine sha. */
export function formatLeaderboard(summary: EvalSummary): string {
  const header = [
    'Model',
    'Profile',
    'Runs',
    'Step success',
    'Bug detection',
    'False-fail',
    'False-pass',
    'Needs-review',
    'Heal success',
    'Replay hit',
    'Latency p50',
    'Latency p95',
    'Escalations',
  ];
  const rows = summary.models.map((m) => [
    m.id,
    m.profile ?? '-',
    String(m.metrics.runs),
    pct(m.metrics.stepSuccessRate),
    pct(m.metrics.bugDetectionRate),
    pct(m.metrics.falseFailRate),
    pct(m.metrics.falsePassRate),
    pct(m.metrics.needsReviewRate),
    pct(m.metrics.healSuccessRate),
    pct(m.metrics.replayHitRate),
    ms(m.metrics.latencyP50Ms),
    ms(m.metrics.latencyP95Ms),
    String(m.metrics.escalations),
  ]);
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [
    `# Eval leaderboard: ${summary.suite}`,
    '',
    `Mode: ${summary.mode} · repeat: ${summary.repeat} · engine: ${summary.engine.gitSha} · started: ${summary.startedAt}`,
    '',
    line(header),
    line(header.map(() => '---')),
    ...rows.map(line),
    '',
    'False-pass (a seeded bug that passed) is the most dangerous number: it must be 0.',
    '',
  ].join('\n');
}

/** Finds `suites/<name>/suite.yaml` upwards from `cwd`, or accepts a path to a suite file or directory. */
export function resolveSuiteFile(suite: string, cwd: string): string {
  const direct = resolve(cwd, suite);
  if (existsSync(direct)) {
    const file = statSync(direct).isDirectory() ? join(direct, 'suite.yaml') : direct;
    if (existsSync(file)) return file;
  }
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const candidate = join(dir, 'suites', suite, 'suite.yaml');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) break;
  }
  throw new S1PilotError('CONFIG_ERROR', `Eval suite not found: ${suite} (looked for suites/${suite}/suite.yaml)`, { suite });
}

/** Loads and validates a suite; cross-checks that every run entry names a known case. */
export function loadSuite(file: string): { suite: EvalSuite; dir: string } {
  const parsed = EvalSuiteSchema.safeParse(parseYaml(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new S1PilotError('CONFIG_ERROR', `Invalid suite ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, {});
  }
  const keys = new Set(parsed.data.cases.map((c) => c.key));
  for (const r of parsed.data.runs) {
    if (!keys.has(r.case)) throw new S1PilotError('CONFIG_ERROR', `Suite ${file}: run entry names unknown case ${r.case}`, {});
  }
  return { suite: parsed.data, dir: dirname(file) };
}

/** Options of `s1pilot eval`. */
export interface EvalOptions {
  suite: string;
  modelUrl?: string;
  models?: string;
  model?: string;
  adapter?: string;
  profile?: string;
  key?: string;
  repeat: number;
  out: string;
  baseUrl?: string;
  oracle?: boolean;
  browser?: 'chromium' | 'firefox' | 'webkit';
}

/** Side effects of `eval`, injectable for tests. */
export interface EvalDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  /** Runs one case; defaults to `executeRun`. */
  run?: typeof executeRun;
  /** Engine git sha; defaults to `git rev-parse --short HEAD`. */
  gitSha?: () => string;
  now?: () => Date;
}

function defaultGitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function profileFor(id: string, explicit: string | undefined): string | null {
  const candidate = explicit ?? id;
  try {
    return loadProfile(candidate).id;
  } catch {
    return null;
  }
}

/** Builds the record of one run from its JSON report. */
function toRecord(
  base: Pick<EvalRunRecord, 'model' | 'profile' | 'engineSha' | 'case' | 'bugs' | 'variants' | 'repeat' | 'phase' | 'expected' | 'expectHealing' | 'dir'>,
  report: RunReport | undefined,
): EvalRunRecord {
  const steps = (report?.cases ?? []).flatMap((c) => c.steps).filter((s) => s.verdict !== 'skipped');
  const decisions = steps.flatMap((s) => s.decisions);
  const verdict = report?.cases[0]?.verdict ?? 'blocked';
  const healed = steps.some((s) => s.mode === 'healed');
  return {
    ...base,
    verdict,
    correct: verdict === base.expected && (!base.expectHealing || base.phase !== 'replay' || healed),
    healed,
    stepsExecuted: steps.length,
    stepsPassed: steps.filter((s) => s.verdict === 'passed').length,
    replayedSteps: steps.filter((s) => s.mode === 'replay').length,
    replayStepsExecuted: steps.length,
    latenciesMs: decisions.map((d) => d.latencyMs),
    escalations: decisions.filter((d) => d.escalatedTo !== undefined).length,
  };
}

/**
 * Runs the eval: for each model x suite entry x repeat it (1) learns the case on the clean site,
 * (2) explores the entry's bug/variant set and (3) replays the learned script against it, then
 * writes `<out>/<timestamp>/summary.json` and `leaderboard.md`. Returns the summary and the directory.
 */
export async function runEval(opts: EvalOptions, deps: EvalDeps, cwd = process.cwd()): Promise<{ summary: EvalSummary; dir: string }> {
  const run = deps.run ?? executeRun;
  const now = deps.now ?? (() => new Date());
  const sha = (deps.gitSha ?? defaultGitSha)();
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new S1PilotError('CONFIG_ERROR', '--repeat must be a whole number of at least 1', {});
  const { suite, dir: suiteDir } = loadSuite(resolveSuiteFile(opts.suite, cwd));

  let models: { id: string; adapter: string }[];
  if (opts.oracle) {
    models = [{ id: 'oracle', adapter: 'mock' }];
  } else {
    const ids = (opts.models ? opts.models.split(',') : opts.model ? [opts.model] : []).map((m) => m.trim()).filter(Boolean);
    if (ids.length === 0) throw new S1PilotError('CONFIG_ERROR', 'Pass --models <a,b> (or --model) with --model-url, or use --oracle for the mock model.', {});
    if (!opts.modelUrl) throw new S1PilotError('CONFIG_ERROR', '--model-url is required unless --oracle is set.', {});
    models = ids.map((id) => ({ id, adapter: opts.adapter ?? 'systemone' }));
  }
  if (opts.oracle) {
    const missing = suite.cases.filter((c) => c.mockScript === undefined && suite.runs.some((r) => r.case === c.key));
    if (missing.length > 0) throw new S1PilotError('CONFIG_ERROR', `Oracle mode needs a mockScript for: ${missing.map((c) => c.key).join(', ')}`, {});
  }

  const startedAt = now().toISOString();
  const out = resolve(cwd, opts.out, startedAt.replace(/[:.]/g, '-'));
  await mkdir(out, { recursive: true });
  const origin = (opts.baseUrl ?? suite.baseUrl).replace(/\/+$/, '');
  const records: EvalRunRecord[] = [];

  for (const model of models) {
    const profile = opts.oracle ? null : profileFor(model.id, opts.profile);
    for (const [entryIndex, entry] of suite.runs.entries()) {
      const testCase = suite.cases.find((c) => c.key === entry.case);
      if (!testCase) continue;
      const expectHealing = entry.variants.length > 0;
      for (let repeat = 1; repeat <= opts.repeat; repeat++) {
        // A private project directory per series keeps learned scripts apart between models and repeats.
        const project = await mkdtemp(join(tmpdir(), 's1p-eval-'));
        try {
          await mkdir(join(project, '.s1pilot'), { recursive: true });
          await writeFile(
            join(project, '.s1pilot', 'project.yaml'),
            stringifyYaml({
              key: 'EVAL',
              name: `Eval ${suite.name}`,
              defaultEnvironment: 'eval',
              environments: [
                { name: 'eval', baseUrl: `${origin}${testCase.site}`, variables: Object.entries(suite.variables).map(([key, value]) => ({ key, value })) },
              ],
            }),
          );
          const siteUrl = (bugs: string[], variants: string[]): string => {
            const query = [bugs.length ? `bugs=${bugs.join(',')}` : '', variants.length ? `variants=${variants.join(',')}` : ''].filter(Boolean).join('&');
            return `${origin}${testCase.site}${query ? `?${query}` : ''}`;
          };
          const phases: { phase: EvalRunRecord['phase']; mode: 'explore' | 'replay-heal'; bugs: string[]; variants: string[] }[] = [
            { phase: 'learn', mode: 'explore', bugs: [], variants: [] },
            { phase: 'explore', mode: 'explore', bugs: entry.bugs, variants: entry.variants },
            { phase: 'replay', mode: 'replay-heal', bugs: entry.bugs, variants: entry.variants },
          ];
          for (const p of phases) {
            const rel = join('runs', safeName(model.id), `${entryIndex + 1}-${safeName(entry.case)}-r${repeat}-${p.phase}`);
            const runOpts: RunOptions = {
              browser: opts.browser ?? 'chromium',
              out: join(out, rel),
              project,
              baseUrl: siteUrl(p.bugs, p.variants),
              mode: p.mode,
              reporter: 'json',
              adapter: model.adapter,
              model: model.id,
              ...(opts.oracle && testCase.mockScript ? { mockScript: resolve(suiteDir, testCase.mockScript) } : {}),
              ...(!opts.oracle && opts.modelUrl ? { modelUrl: opts.modelUrl } : {}),
              ...(opts.key ? { key: opts.key } : {}),
              ...(profile ? { profile } : {}),
            };
            const quietLines: string[] = [];
            const code = await run(resolve(suiteDir, testCase.file), runOpts, {
              stdout: () => undefined,
              stderr: (t) => quietLines.push(t),
              env: deps.env,
            });
            let report: RunReport | undefined;
            const reportFile = join(runOpts.out, 'report.json');
            if (existsSync(reportFile)) report = RunReportSchema.parse(JSON.parse(await readFile(reportFile, 'utf8')));
            if (!report && code === 3) {
              throw new S1PilotError('CONFIG_ERROR', `Eval run failed to start: ${quietLines.join('').trim() || 'configuration error'}`, {});
            }
            records.push(
              toRecord(
                {
                  model: model.id,
                  profile,
                  engineSha: sha,
                  case: entry.case,
                  bugs: entry.bugs,
                  variants: entry.variants,
                  repeat,
                  phase: p.phase,
                  expected: p.phase === 'learn' ? 'passed' : entry.verdict,
                  expectHealing: p.phase === 'learn' ? false : expectHealing,
                  dir: rel,
                },
                report,
              ),
            );
          }
        } finally {
          await rm(project, { recursive: true, force: true });
        }
      }
    }
  }

  const summary: EvalSummary = {
    version: 1,
    suite: suite.name,
    mode: opts.oracle ? 'oracle' : 'live',
    startedAt,
    finishedAt: now().toISOString(),
    repeat: opts.repeat,
    engine: { gitSha: sha },
    models: models.map((m) => {
      const own = records.filter((r) => r.model === m.id);
      return { id: m.id, profile: own[0]?.profile ?? null, adapter: m.adapter, metrics: computeMetrics(own) };
    }),
    runs: records,
  };
  await writeFile(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(out, 'leaderboard.md'), formatLeaderboard(summary));
  return { summary, dir: out };
}

/** Terminal wrapper: prints the leaderboard and returns the exit code (0 ok, 1 a seeded bug passed, 3 config error). */
export async function executeEval(opts: EvalOptions, deps: EvalDeps): Promise<number> {
  try {
    const { summary, dir } = await runEval(opts, deps);
    deps.stdout(`${formatLeaderboard(summary)}\nResults: ${dir}\n`);
    return summary.models.some((m) => (m.metrics.falsePassRate ?? 0) > 0) ? 1 : 0;
  } catch (error) {
    if (error instanceof S1PilotError) {
      deps.stderr(`error: ${error.message}\n`);
      return 3;
    }
    throw error;
  }
}

/** Registers `s1pilot eval`. */
export function registerEvalCommand(program: Command, deps: CliDeps): void {
  program
    .command('eval')
    .description('Measure engine quality against fixture ground truth (exit codes: 0 ok, 1 a seeded bug passed, 3 config error)')
    .requiredOption('--suite <name>', 'suite name (suites/<name>/suite.yaml) or path to a suite file')
    .option('--model-url <url>', 'System 1 model server base URL')
    .option('--models <names>', 'comma-separated model names to compare (profile id = model name when a profile exists)')
    .option('--model <name>', 'a single model name')
    .option('--adapter <adapter>', 'System 1 adapter', 'systemone')
    .option('--profile <id>', 'capability profile for all models (default: the model name when a profile exists)')
    .option('--key <key>', 'System 1 API key (or set S1PILOT_API_KEY)')
    .option('--repeat <n>', 'repetitions of every entry', (v) => Number.parseInt(v, 10), 1)
    .option('--out <dir>', 'results directory (a timestamped folder is created inside)', './eval-results')
    .option('--base-url <url>', 'origin of the running fixture server (default: from the suite)')
    .option('--oracle', 'use the scripted mock model that always answers correctly (checks harness wiring, not model quality)')
    .action(async (opts: EvalOptions) => {
      deps.setExitCode(await executeEval(opts, { stdout: deps.stdout, stderr: deps.stderr, env: deps.env }));
    });
}
