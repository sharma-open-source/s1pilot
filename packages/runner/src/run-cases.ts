import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  newId,
  type BrowserName,
  type CaptureFile,
  type CaseMode,
  type CaseRunResult,
  type DecisionModel,
  type Environment,
  type ExecutionMode,
  type Redactor,
  type RunEvent,
  type RunReport,
  type StepReport,
  type TestCase,
  type Thresholds,
  type Verdict,
} from '@s1pilot/domain';
import {
  LearnedRecorder,
  StepCapture,
  buildLearnedScript,
  caseVerdict,
  chooseMode,
  createJsonlTraceWriter,
  exploreStep,
  expandCase,
  installDomainGuard,
  installReadOnlyGuard,
  replayWithHeal,
  verifyStep,
  type CaseInstance,
  type EngineContext,
  type ExpandOptions,
  type HealProposalDraft,
  type HumanHook,
  type InstalledGuard,
} from '@s1pilot/engine';
import type { ChatModel } from '@s1pilot/providers';
import type { LearnedScriptRef, LearnedScriptStore } from '@s1pilot/sync';
import { chromium, firefox, webkit, type Browser, type BrowserContextOptions, type Page } from 'playwright';

import { CaseCapture, type CaptureOptions } from './capture.js';

/** Full result of a run; the reporters render exactly this. */
export type RunSummary = RunReport;

/** Models used by a run. */
export interface RunnerModels {
  s1: DecisionModel;
  s2?: ChatModel;
  thresholds: Thresholds;
  /** Name stored on decision records. */
  modelName: string;
}

/** Persistence used by a run. Both parts are optional: without them nothing is learned or proposed. */
export interface RunnerStores {
  /** Learned scripts; replay needs it, a passing explore run writes to it. */
  scripts?: LearnedScriptStore;
  /** Receives heal proposals (`repos.healProposals.create` in server mode). Failures are reported, not fatal. */
  healProposals?: { create(draft: HealProposalDraft): Promise<unknown> };
}

/**
 * Auth setup hook (S-038 fills it): returns the Playwright storage state to start a case's context
 * with, or `undefined` for a fresh anonymous context.
 */
export interface AuthStateProvider {
  storageState(testCase: TestCase, environment: Environment): Promise<BrowserContextOptions['storageState'] | undefined>;
}

/** Variables available to `var:` / `secret:` refs. */
export type RunnerVars = EngineContext['vars'];

/** Progress events of {@link runCases}. */
export type RunnerEvent =
  | { type: 'run.started'; runId: string; totalCases: number }
  | { type: 'case.started'; runId: string; caseResultId: string; key: string; title: string; label?: string; mode: CaseMode }
  /** A line of diagnostics (blocked requests, learned-script notes). */
  | { type: 'note'; caseResultId: string; text: string }
  | { type: 'step.finished'; caseResultId: string; key: string; step: StepReport }
  | { type: 'case.finished'; caseResultId: string; result: CaseRunResult }
  /** Engine run events (decisions, assertions, escalations) forwarded as they happen. */
  | { type: 'engine'; event: RunEvent }
  | { type: 'run.finished'; report: RunReport };

/** Input of {@link runCases}. */
export interface RunCasesInput {
  cases: TestCase[];
  environment: Environment;
  /** Launched browser; every case gets a fresh context on it. */
  browser: Browser;
  browserName: BrowserName;
  /** `replay-heal` (default): replay learned scripts, heal broken steps; `replay-only`: never call a model; `explore`: always explore. */
  mode?: ExecutionMode;
  models: RunnerModels;
  stores?: RunnerStores;
  emit?: (event: RunnerEvent) => void;
  /** Allow asking `human` when the engine cannot decide. */
  attended?: boolean;
  human?: HumanHook;
  /** Output directory: `<out>/<case>/trace.jsonl` + `result.json` per case instance. */
  out: string;
  /** Case instances running at the same time, each in its own browser context. Default 1. */
  parallelism?: number;
  vars: RunnerVars;
  redactor: Redactor;
  /** Lookups for `flow:` shared steps and datasets, passed to `expandCase`. */
  flows?: ExpandOptions['flows'];
  datasets?: ExpandOptions['datasets'];
  auth?: AuthStateProvider;
  /** Suite name of a case (reporters group by it). Default: the case's `suiteId`, else `default`. */
  suiteOf?: (testCase: TestCase) => string;
  /**
   * Cancels the run: no further case instances start, and running ones are stopped by closing their
   * browser context (in-flight actions fail immediately). Instances stopped this way are left out of
   * the report. Used by the server's `runs.cancel`.
   */
  signal?: AbortSignal;
  /**
   * Called with the case instance's page right after it is created (live view / screencast, S-036). The returned
   * function (if any) is called when the instance ends, before its context closes. Errors are ignored.
   */
  onPage?: (page: Page, info: { runId: string; caseResultId: string }) => (() => unknown) | undefined;
  /** Evidence capture (screenshots, video, trace, logs). Defaults: screenshots, trace and logs on; video off. */
  capture?: CaptureOptions;
}

const bind = (text: string, params: Record<string, string>): string => text.replace(/\{([\w.-]+)\}/g, (whole, name: string) => params[name] ?? whole);

const safeName = (s: string): string => s.replace(/[^\w.-]+/g, '_');

/** Directory name of a case instance below the output directory. */
export function caseDirName(key: string, row: number, count: number): string {
  return `${safeName(key)}${count > 1 ? `-${row + 1}` : ''}`;
}

/** Results of instances that finished while the run's abort signal was set. */
const cancelledResults = new WeakSet<CaseRunResult>();

interface Job {
  instance: CaseInstance;
  dir: string;
}

/**
 * Runs test cases and returns the full {@link RunSummary} (plan sections 2.3, 2.7).
 *
 * Per case instance (one per parameter row, see `expandCase`): a fresh browser context (with the
 * auth storage state when {@link AuthStateProvider} provides one), then {@link chooseMode} decides
 * between replaying the learned script (healing broken steps with System 1 unless `mode` is
 * `replay-only`) and exploring; every step is verified and the case verdict is the worst step
 * verdict. A passing explore run saves a learned script. Heal proposals go to `stores.healProposals`.
 * Instances run through a worker pool of `parallelism` contexts (default 1); the report keeps
 * the input order. `replay-only` without a usable script yields a `blocked` case.
 */
export async function runCases(input: RunCasesInput): Promise<RunSummary> {
  const emit = input.emit ?? ((): void => undefined);
  const runId = newId();
  const startedAt = new Date();
  const jobs: Job[] = [];
  for (const testCase of input.cases) {
    for (const instance of expandCase(testCase, {
      ...(input.flows ? { flows: input.flows } : {}),
      ...(input.datasets ? { datasets: input.datasets } : {}),
    })) {
      jobs.push({ instance, dir: caseDirName(testCase.key, instance.index, instance.count) });
    }
  }
  emit({ type: 'run.started', runId, totalCases: jobs.length });

  const results: CaseRunResult[] = new Array<CaseRunResult>(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(input.parallelism ?? 1, jobs.length)) }, async () => {
    while (next < jobs.length) {
      if (input.signal?.aborted) return;
      const i = next++;
      const job = jobs[i] as Job;
      results[i] = await runInstance(input, runId, job, emit);
    }
  });
  await Promise.all(workers);

  const finishedAt = new Date();
  // Aborted runs leave holes (never started) and drop instances stopped midway.
  const aborted = input.signal?.aborted === true;
  const finished = results.filter((r): r is CaseRunResult => r !== undefined && !(aborted && cancelledResults.has(r)));
  results.length = 0;
  results.push(...finished);
  const count = (v: Verdict): number => results.filter((r) => r.verdict === v).length;
  const executed = results.flatMap((r) => r.steps).filter((s) => s.verdict !== 'skipped');
  const passedSteps = executed.filter((s) => s.verdict === 'passed').length;
  const report: RunReport = {
    runId,
    environment: input.environment.name,
    browser: input.browserName,
    mode: input.mode ?? 'replay-heal',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    totals: {
      passed: count('passed'),
      failed: count('failed'),
      blocked: count('blocked'),
      skipped: count('skipped'),
      flaky: count('flaky'),
      needsReview: count('needs-review'),
    },
    steps: { executed: executed.length, passed: passedSteps, successRate: executed.length === 0 ? 0 : passedSteps / executed.length },
    cases: results,
  };
  emit({ type: 'run.finished', report });
  return report;
}

const emptyStep = (index: number, action: string, extra: Partial<StepReport> = {}): StepReport => ({
  index,
  action,
  verdict: 'skipped',
  actions: 0,
  iterations: 0,
  durationMs: 0,
  assertions: [],
  decisions: [],
  ...extra,
});

async function runInstance(input: RunCasesInput, runId: string, job: Job, emit: (e: RunnerEvent) => void): Promise<CaseRunResult> {
  const { instance, dir } = job;
  const { environment, redactor, models } = input;
  const { testCase, params } = instance;
  const r = (s: string): string => redactor.redact(s);
  const startedAt = new Date();
  const caseResultId = newId();
  const planMode: ExecutionMode = input.mode ?? 'replay-heal';
  const caseDir = join(input.out, dir);
  const note = (text: string): void => emit({ type: 'note', caseResultId, text });

  const queue = [
    ...instance.preconditionSteps.map((step) => ({ step, pre: true })),
    ...testCase.steps.map((step) => ({ step, pre: false })),
  ];
  const hashable = queue.map((q) => q.step);
  // Instances with different bound steps get their own script; a single instance keeps the plain case key.
  const ref: LearnedScriptRef = {
    caseKey: instance.count > 1 ? instance.scriptKey : testCase.key,
    caseId: testCase.id,
    environmentName: environment.name,
    environmentId: environment.id,
  };
  const script = planMode === 'explore' || !input.stores?.scripts ? undefined : await input.stores.scripts.get(ref);
  const choice = chooseMode({ steps: hashable }, environment, planMode, script);
  const replaying = choice.mode !== 'explore' && script !== undefined;

  emit({
    type: 'case.started',
    runId,
    caseResultId,
    key: testCase.key,
    title: r(testCase.title),
    ...(instance.label ? { label: instance.label } : {}),
    mode: replaying ? 'replay' : 'explore',
  });

  const steps: StepReport[] = [];
  let proposals = 0;
  const finishStep = (step: StepReport): void => {
    steps.push(step);
    emit({ type: 'step.finished', caseResultId, key: testCase.key, step });
  };
  let files: CaptureFile[] = [];
  const finishCase = async (verdict: Verdict, mode: CaseMode): Promise<CaseRunResult> => {
    const result: CaseRunResult = {
      runId,
      caseResultId,
      key: testCase.key,
      title: r(testCase.title),
      suite: input.suiteOf?.(testCase) ?? testCase.suiteId ?? 'default',
      priority: testCase.priority,
      row: instance.index + 1,
      ...(instance.label ? { label: instance.label } : {}),
      mode,
      verdict,
      environment: environment.name,
      browser: input.browserName,
      params,
      scriptKey: instance.scriptKey,
      dir,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      healProposals: proposals,
      steps,
      ...(files.length > 0 ? { files } : {}),
    };
    const safe = redactor.redactDeep(result);
    if (input.signal?.aborted) cancelledResults.add(safe);
    await mkdir(caseDir, { recursive: true });
    await writeFile(join(caseDir, 'result.json'), `${JSON.stringify(safe, null, 2)}\n`);
    emit({ type: 'case.finished', caseResultId, result: safe });
    return safe;
  };

  // replay-only without a usable script never falls back to the model.
  if (choice.blocked) {
    queue.forEach(({ step, pre }, index) => {
      const action = r(bind(step.action, params));
      finishStep(
        index === 0
          ? emptyStep(index, action, {
              verdict: 'blocked',
              reason: `replay-only: no usable learned script (${choice.reason})`,
              ...(pre ? { phase: 'precondition' as const } : {}),
            })
          : emptyStep(index, action, pre ? { phase: 'precondition' } : {}),
      );
    });
    return finishCase('blocked', 'explore');
  }

  const tracePath = join(caseDir, 'trace.jsonl');
  await mkdir(caseDir, { recursive: true });
  await rm(tracePath, { force: true });
  const trace = createJsonlTraceWriter(tracePath);

  if (testCase.preconditions.some((p) => 'auth' in p) && !input.auth) {
    // TODO(S-038): auth setup flows restore a saved login state.
    note('! auth preconditions are not applied yet');
  }
  const storageState = await input.auth?.storageState(testCase, environment);
  const evidence = new CaseCapture(caseDir, CaseCapture.options(input.capture), redactor, input.vars.secretValues());
  const context = await input.browser.newContext({
    locale: environment.locale,
    timezoneId: environment.timezone,
    ...(storageState ? { storageState } : {}),
    ...(input.capture?.video ? { recordVideo: { dir: evidence.videoDir, size: { width: 1280, height: 720 } } } : {}),
  });
  await evidence.start(context);
  const guards: InstalledGuard[] = [];
  const onEvent = (e: { method?: string; url?: string; reason: string }): void => {
    note(`! blocked ${e.method ?? ''} ${r(e.url ?? '')}: ${e.reason}`.replace(/\s+/g, ' '));
  };
  const recorder = new LearnedRecorder(runId, hashable);
  const onAbort = (): void => void context.close().catch(() => undefined);
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  let releasePage: (() => unknown) | undefined;
  let stop: Verdict | undefined;
  let preconditionBroken = false;
  let anyHealed = false;
  try {
    guards.push(await installDomainGuard(context, { baseUrl: environment.baseUrl, allowDomains: environment.allowDomains, onEvent }));
    if (environment.readOnly) guards.push(await installReadOnlyGuard(context, { onEvent }));
    const page = await context.newPage();
    try {
      const release = input.onPage?.(page, { runId, caseResultId });
      if (release) releasePage = release;
    } catch {
      // A faulty live-view hook must not break the run.
    }
    const ctx: EngineContext = {
      page,
      s1: models.s1,
      ...(models.s2 ? { s2: models.s2 } : {}),
      ...(input.human && input.attended ? { human: input.human, attended: true } : {}),
      vars: input.vars,
      params,
      environment,
      thresholds: models.thresholds,
      caps: models.s1.capabilities,
      redactor,
      emit: (event) => emit({ type: 'engine', event }),
      trace,
      budgets: {},
      runId,
      caseResultId,
      modelName: models.modelName,
      // Replay and heal never rewrite the script; only a full explore run is learned.
      ...(replaying ? {} : { recorder }),
    };

    try {
      await page.goto(environment.baseUrl);
    } catch (error) {
      stop = 'blocked';
      finishStep(
        emptyStep(0, `Open ${environment.baseUrl}`, {
          verdict: 'blocked',
          reason: r(`Could not open ${environment.baseUrl}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`),
        }),
      );
    }

    for (const [index, { step, pre }] of queue.entries()) {
      const action = bind(step.action, params);
      const tag = {
        ...(pre ? { phase: 'precondition' as const } : {}),
        ...(step.sharedStepId ? { sharedStepId: step.sharedStepId } : {}),
      };
      if (stop === undefined && input.signal?.aborted) stop = 'failed';
      if (stop !== undefined) {
        finishStep(emptyStep(index, r(action), tag));
        continue;
      }
      const capture = StepCapture.start(ctx.page);
      let record: StepReport;
      try {
        const stepInput = { index, action: step.action, inputs: step.inputs, ...(step.sharedStepId ? { sharedStepId: step.sharedStepId } : {}) };
        let mode: StepReport['mode'] = 'explore';
        let executionStatus: 'passed' | 'failed' | 'blocked';
        let detail: Pick<StepReport, 'ended' | 'reason' | 'actionTaken' | 'actions' | 'iterations' | 'durationMs' | 'decisions'>;
        if (replaying && script) {
          const replayed = await replayWithHeal(ctx, {
            caseId: testCase.id,
            environmentId: environment.id,
            steps: [stepInput],
            script,
            mode: choice.mode === 'replay-only' ? 'replay-only' : 'replay-heal',
          });
          const outcome = replayed.steps[0];
          mode = outcome?.mode ?? 'replay';
          executionStatus = replayed.status;
          const exec = outcome?.heal?.execution;
          detail = {
            ...(exec ? { ended: exec.ended } : { ended: replayed.status === 'passed' ? 'done' : 'replay-break' }),
            ...(exec?.reason ?? outcome?.heal?.reason ?? outcome?.replay.break?.message
              ? { reason: exec?.reason ?? outcome?.heal?.reason ?? outcome?.replay.break?.message ?? '' }
              : {}),
            ...(exec?.actionTaken ? { actionTaken: r(exec.actionTaken) } : {}),
            actions: exec ? exec.actions.length : (outcome?.replay.actions.length ?? 0),
            iterations: exec?.iterations ?? 0,
            durationMs: (outcome?.replay.durationMs ?? 0) + (exec?.durationMs ?? 0),
            decisions: exec?.decisions ?? [],
          };
          for (const draft of replayed.proposals) {
            proposals++;
            anyHealed = true;
            if (input.stores?.healProposals) {
              try {
                await input.stores.healProposals.create(draft);
              } catch (error) {
                note(`! heal proposal for step ${index + 1} was not saved: ${r(error instanceof Error ? error.message : String(error))}`);
              }
            } else {
              note(`! heal proposal for step ${index + 1} was not saved: no proposal store configured`);
            }
          }
        } else {
          const exec = await exploreStep(ctx, stepInput);
          executionStatus = exec.status === 'passed' || exec.status === 'blocked' ? exec.status : 'failed';
          detail = {
            ended: exec.ended,
            ...(exec.reason ? { reason: exec.reason } : {}),
            ...(exec.actionTaken ? { actionTaken: r(exec.actionTaken) } : {}),
            actions: exec.actions.length,
            iterations: exec.iterations,
            durationMs: exec.durationMs,
            decisions: exec.decisions,
          };
        }
        const verification = await verifyStep(
          { page: ctx.page, s1: ctx.s1, thresholds: ctx.thresholds, redactor, modelName: models.modelName },
          {
            ...(step.expected ? { expected: bind(step.expected, params) } : {}),
            assertions: step.assert,
            priority: testCase.priority,
            capture,
            executionStatus,
          },
        );
        record = {
          index,
          ...tag,
          action: r(action),
          verdict: verification.verdict,
          mode,
          ...detail,
          ...(detail.reason ? { reason: r(detail.reason) } : {}),
          assertions: verification.stepAssertions,
          decisions: [...detail.decisions, ...verification.decisions],
        };
      } catch (error) {
        record = emptyStep(index, r(action), {
          ...tag,
          verdict: 'failed',
          ended: 'error',
          reason: r(error instanceof Error ? error.message : String(error)),
        });
      } finally {
        capture.dispose();
      }
      const screenshot = await evidence.screenshot(ctx.page, index);
      finishStep(screenshot ? { ...record, screenshot } : record);
      if (record.verdict === 'failed' || record.verdict === 'blocked') {
        // A broken precondition means the case never really ran: blocked, not failed.
        if (pre) preconditionBroken = true;
        stop = pre ? 'blocked' : record.verdict;
      }
    }
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    for (const g of guards) await g.dispose().catch(() => undefined);
    await trace.close?.();
    try {
      await releasePage?.();
    } catch {
      // ignore
    }
    await evidence.stopTrace(context);
    await context.close();
  }
  files = await evidence.finish();
  files.push({ kind: 'log', file: 'trace.jsonl', contentType: 'application/x-ndjson' });

  const verdict = preconditionBroken ? 'blocked' : caseVerdict(steps.map((s) => s.verdict));
  // A passing explore run (first run, or a stale / environment-changed script) is learned.
  if (!replaying && input.stores?.scripts) {
    const learned = buildLearnedScript({
      caseId: testCase.id,
      caseVersion: testCase.version,
      environmentId: environment.id,
      runId,
      verdict,
      recorder,
    });
    if (learned) {
      await input.stores.scripts.put(ref, learned);
      note(`learned script saved (${learned.actions.length} actions)`);
    }
  }
  const caseMode: CaseMode = !replaying ? 'explore' : anyHealed ? 'healed' : 'replay';
  return finishCase(verdict, caseMode);
}

/** Options of {@link launchBrowser}. */
export interface LaunchBrowserOptions {
  /** Show the browser window. Default false (headless). */
  headed?: boolean;
}

/**
 * Launches a Playwright browser for {@link runCases}. Lets callers (the server's workers) avoid a direct
 * dependency on `playwright`.
 */
export async function launchBrowser(name: BrowserName, opts: LaunchBrowserOptions = {}): Promise<Browser> {
  const launcher = { chromium, firefox, webkit }[name];
  return launcher.launch({ headless: opts.headed !== true });
}
