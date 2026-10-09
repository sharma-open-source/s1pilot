import { CheckResultSchema, IdSchema, S1PilotError, VerdictSchema, type CheckResult, type StepResult } from '@s1pilot/domain';
import { z } from 'zod';

import { FsArtifactStore } from '../../artifacts/store.js';
import { evaluateExitCriteria, getSignOff } from '../../exit-criteria/evaluate.js';
import { publicProcedure, router } from '../trpc.js';

import { applyVerdict } from './verdicts.js';

const MAX_LOG_ENTRIES = 500;

/** Browser shown when a result has none recorded. */
const DEFAULT_BROWSER = 'chromium';

/** 1-based number of the first failed / blocked step, if any. */
function failedStepNo(steps: StepResult[]): number | null {
  const s = steps.find((x) => x.status === 'failed' || x.status === 'blocked');
  return s ? s.stepIndex + 1 : null;
}

/** Entries of a stored JSON log artifact (`console.json` is an array, `network.json` has `entries`); empty when unreadable. */
async function loadEntries(store: FsArtifactStore, id: string | undefined, wrapped: boolean): Promise<Array<Record<string, unknown>>> {
  if (!id) return [];
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of await store.get(id)) chunks.push(Buffer.from(chunk as Uint8Array));
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    const list = wrapped ? (json as Record<string, unknown>)['entries'] : json;
    return Array.isArray(list) ? (list.slice(0, MAX_LOG_ENTRIES) as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}

/** Stored `checks.json` of a result (a11y / console / network check results); empty when absent or unreadable. */
export async function loadChecks(store: FsArtifactStore, id: string | undefined): Promise<CheckResult[]> {
  if (!id) return [];
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of await store.get(id)) chunks.push(Buffer.from(chunk as Uint8Array));
    return z.array(CheckResultSchema).parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    return [];
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** `runs.report(runId)`: summary, exit-criteria evaluation and the results list. */
export const reportProcedure = publicProcedure.input(IdSchema).query(async ({ ctx, input }) => {
  const run = await ctx.repos.runs.get(ctx.db, input);
  if (!run) throw new S1PilotError('RUN_NOT_FOUND', `Run not found: ${input}`, { runId: input });
  const project = await ctx.repos.projects.get(ctx.db, run.projectId);
  const results = await ctx.repos.results.listCases(ctx.db, run.id);
  const envNames = new Map<string, string>();
  const rows = await Promise.all(
    results.map(async (r) => {
      const c = await ctx.repos.cases.get(ctx.db, r.caseId);
      let environment = '';
      if (r.environmentId) {
        if (!envNames.has(r.environmentId)) {
          envNames.set(r.environmentId, (await ctx.repos.environments.get(ctx.db, r.environmentId))?.name ?? '');
        }
        environment = envNames.get(r.environmentId) ?? '';
      }
      const steps = await ctx.repos.results.listSteps(ctx.db, r.id);
      return {
        id: r.id,
        caseId: r.caseId,
        key: c?.key ?? r.caseId,
        title: c?.title ?? '',
        verdict: r.verdict,
        environment,
        browser: r.browser ?? DEFAULT_BROWSER,
        mode: r.mode,
        attempt: r.attempt,
        ...(r.reason ? { reason: r.reason, note: `${r.verdict} (${r.reason})` } : {}),
        checks: r.checks ?? [],
        durationMs: r.durationMs,
        failedStep: failedStepNo(steps),
      };
    }),
  );
  const plan = run.planId ? await ctx.repos.plans.get(ctx.db, run.planId) : undefined;
  const evaluation = plan ? await evaluateExitCriteria(run, plan, ctx.db) : undefined;
  return {
    run,
    projectKey: project?.key ?? '',
    environments: [...new Set(rows.map((r) => r.environment).filter(Boolean))],
    exitCriteria: evaluation && evaluation.items.length > 0 ? { met: evaluation.items.filter((i) => i.met).length, total: evaluation.items.length, allMet: evaluation.met, items: evaluation.items.map((i) => ({ label: i.label, met: i.met, actual: i.actual, detail: i.detail })) } : null,
    signOff: await getSignOff(ctx.db, run.id),
    results: rows,
  };
});

/** Case-result procedures: `get` (detail with evidence) and `overrideVerdict`. */
export const resultsRouter = router({
  /** One case result: steps (with the case's action / expected text), assertions, decisions and evidence refs. */
  get: publicProcedure.input(IdSchema).query(async ({ ctx, input }) => {
    const result = await ctx.repos.results.getCase(ctx.db, input);
    if (!result) throw new S1PilotError('RESULT_NOT_FOUND', `Result not found: ${input}`, { resultId: input });
    const testCase = await ctx.repos.cases.get(ctx.db, result.caseId);
    const environment = result.environmentId ? await ctx.repos.environments.get(ctx.db, result.environmentId) : undefined;
    const steps = await ctx.repos.results.listSteps(ctx.db, result.id);
    const artifacts = await ctx.repos.artifacts.listByCaseResult(ctx.db, result.id);
    const store = new FsArtifactStore(ctx.db, ctx.config.artifactsDir);
    const video = artifacts.find((a) => a.kind === 'video');
    const trace = artifacts.find((a) => a.kind === 'trace');

    const shots = new Map<number, string>();
    for (const a of artifacts) if (a.kind === 'screenshot' && a.stepIndex !== undefined) shots.set(a.stepIndex, a.id);
    const consoleRaw = await loadEntries(store, artifacts.find((a) => a.kind === 'console')?.id, false);
    const networkRaw = await loadEntries(store, artifacts.find((a) => a.kind === 'network')?.id, true);
    const run = await ctx.repos.runs.get(ctx.db, result.runId);
    const project = run ? await ctx.repos.projects.get(ctx.db, run.projectId) : undefined;
    const reviews = project ? await ctx.repos.reviews.list(ctx.db, { projectId: project.id, kind: 'verdict' }) : [];

    return {
      result,
      projectKey: project?.key ?? '',
      case: { id: result.caseId, key: testCase?.key ?? result.caseId, title: testCase?.title ?? '' },
      environment: environment?.name ?? '',
      failedStep: failedStepNo(steps),
      steps: steps.map((s) => {
        const caseStep = testCase?.steps[s.stepIndex];
        const screenshotId = shots.get(s.stepIndex);
        return {
          ...s,
          // `step_results` has no mode column, so fall back to how the case ran (replay / healed / explore).
          mode: s.mode ?? result.mode,
          action: caseStep?.action ?? '',
          ...(caseStep?.expected ? { expected: caseStep.expected } : {}),
          ...(screenshotId ? { screenshotId } : {}),
        };
      }),
      /** Case steps with no step result (not run because an earlier step stopped the case). */
      notRun: (testCase?.steps ?? []).map((st, i) => ({ index: i, action: st.action })).filter((x) => !steps.some((s) => s.stepIndex === x.index)),
      video: video ? { artifactId: video.id } : null,
      trace: trace ? { artifactId: trace.id, size: trace.size } : null,
      console: consoleRaw.map((o) => ({ ts: str(o['ts']), type: str(o['type']), text: str(o['text']), ...(o['location'] ? { location: str(o['location']) } : {}) })),
      network: networkRaw.map((o) => ({ url: str(o['url']), method: str(o['method']), status: numOrNull(o['status']), durationMs: numOrNull(o['durationMs']), resourceType: str(o['resourceType']) })),
      checks: await loadChecks(store, artifacts.find((a) => a.kind === 'a11y')?.id),
      overrides: reviews.filter((r) => r.refId === result.id),
    };
  }),

  /** Replaces the verdict of a case result, refreshes the run counts and records a review item for calibration. */
  overrideVerdict: publicProcedure
    .input(z.object({ resultId: IdSchema, verdict: VerdictSchema, note: z.string().max(2000).default('') }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot override verdicts');
      const result = await ctx.repos.results.getCase(ctx.db, input.resultId);
      if (!result) throw new S1PilotError('RESULT_NOT_FOUND', `Result not found: ${input.resultId}`, { resultId: input.resultId });
      if (result.verdict === input.verdict) {
        throw new S1PilotError('INVALID_STATE', `Result is already ${input.verdict}`, { resultId: result.id });
      }
      const noteText = `Overridden by ${ctx.user.id}: ${result.verdict} -> ${input.verdict}${input.note ? `. ${input.note}` : ''}`;
      return applyVerdict(ctx, result, input.verdict, { noteText, status: 'approved' });
    }),
});
