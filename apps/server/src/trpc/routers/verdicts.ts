import { S1PilotError, newId, type CaseResult, type ReviewItem, type ReviewOutcome, type RunSummary, type StepResult, type Verdict } from '@s1pilot/domain';

import type { Context } from '../context.js';

/** Counts of case verdicts, in the shape stored on the run. */
export function summarize(verdicts: string[]): RunSummary {
  const count = (v: string): number => verdicts.filter((x) => x === v).length;
  return {
    passed: count('passed'),
    failed: count('failed'),
    blocked: count('blocked'),
    skipped: count('skipped'),
    flaky: count('flaky'),
    needsReview: count('needs-review'),
  };
}

/**
 * Calibration record for a human verdict: P(true) of the AI assertion that was uncertain (or the last AI
 * assertion with a probability), the question type and the model that answered. `undefined` unless the human
 * decided `passed` / `failed`.
 */
export function outcomeFor(steps: StepResult[], human: Verdict, decidedBy: string): ReviewOutcome | undefined {
  if (human !== 'passed' && human !== 'failed') return undefined;
  const withP = steps.flatMap((s) => s.assertions.filter((a) => a.probability !== undefined).map((a) => ({ a, s })));
  const picked = withP.find((x) => x.a.verdict === 'needs-review') ?? withP.at(-1);
  const model = [...(picked?.s.decisions ?? []), ...steps.flatMap((s) => s.decisions)].reverse().find((d) => d.model)?.model ?? null;
  return {
    pTrue: picked?.a.probability ?? null,
    humanVerdict: human,
    questionType: 'noul',
    optionCount: 2,
    model,
    decidedBy,
  };
}

/**
 * Replaces the verdict of a case result, refreshes the run counts (and the run status of a `needs-review` run),
 * and resolves (or records) the `verdict` review item with its `ReviewOutcome`; the workspace counts are pushed.
 * The caller checks permissions.
 */
export async function applyVerdict(
  ctx: Context,
  result: CaseResult,
  verdict: Verdict,
  opts: { noteText: string; status: 'approved' | 'rejected' },
) {
  const run = await ctx.repos.runs.get(ctx.db, result.runId);
  if (!run) throw new S1PilotError('RUN_NOT_FOUND', `Run not found: ${result.runId}`, { runId: result.runId });
  const updated = await ctx.repos.results.updateCase(ctx.db, result.id, { verdict });
  const all = await ctx.repos.results.listCases(ctx.db, run.id);
  const summary = summarize(all.map((r) => r.verdict));
  const status =
    run.status === 'needs-review' && summary.needsReview === 0
      ? summary.failed + summary.blocked + summary.flaky > 0
        ? ('failed' as const)
        : ('passed' as const)
      : undefined;
  await ctx.repos.runs.update(ctx.db, run.id, { summary, ...(status ? { status } : {}) });
  const steps = await ctx.repos.results.listSteps(ctx.db, result.id);
  const outcome = outcomeFor(steps, verdict, ctx.user.id);
  const pending = (await ctx.repos.reviews.list(ctx.db, { projectId: run.projectId, kind: 'verdict', status: 'pending' })).find((r) => r.refId === result.id);
  let review: ReviewItem;
  if (pending) {
    review = await ctx.repos.reviews.resolve(ctx.db, pending.id, opts.status, opts.noteText, outcome);
  } else {
    review = await ctx.repos.reviews.create(ctx.db, {
      id: newId(),
      projectId: run.projectId,
      kind: 'verdict',
      refId: result.id,
      status: opts.status,
      note: opts.noteText,
      ...(outcome ? { outcome } : {}),
      resolvedAt: new Date().toISOString(),
    });
  }
  ctx.runtime.live.notifyWorkspace();
  return { result: updated, summary, review };
}
