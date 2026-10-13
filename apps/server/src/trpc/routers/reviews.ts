import { IdSchema, S1PilotError, can, type HealProposal, type LocatorCandidate, type ResolvedAction, type ReviewItem, type Verdict } from '@s1pilot/domain';
import { z } from 'zod';

import { pendingDraftCount, syncRecords } from '../../generation/service.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';


import { draftRow } from './generate.js';
import { effectiveModelSettings, requireProject } from './helpers.js';
import { applyVerdict } from './verdicts.js';

/** Queue tabs. `drafts` (S-061) comes from the generation records; `visual` (later) has no items yet. */
export const REVIEW_TABS = ['verdicts', 'heals', 'drafts', 'visual'] as const;
const TabSchema = z.enum(REVIEW_TABS);
type Tab = z.infer<typeof TabSchema>;

const KIND_OF_TAB: Partial<Record<Tab, ReviewItem['kind']>> = { verdicts: 'verdict', heals: 'heal' };

/** Items per page of `reviews.list`. */
export const REVIEW_PAGE_SIZE = 20;

/** Playwright-style text of a locator (`getByRole('button', {name: 'Pay'})`). */
export function locatorText(l: LocatorCandidate): string {
  const q = (v: string): string => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  switch (l.kind) {
    case 'role':
      return l.name !== undefined ? `getByRole(${q(l.value)}, {name: ${q(l.name)}})` : `getByRole(${q(l.value)})`;
    case 'testId':
      return `getByTestId(${q(l.value)})`;
    case 'text':
      return `getByText(${q(l.value)})`;
    case 'css':
      return `locator(${q(l.value)})`;
  }
}

/** One line per action of a step: the primary locator, prefixed with the action kind unless it is a click. */
function actionLines(actions: readonly ResolvedAction[]): string[] {
  return actions.map((a) => {
    const loc = a.locators[0];
    const target = loc ? locatorText(loc) : '(no locator)';
    return a.action === 'click' ? target : `${a.action} ${target}`;
  });
}

/** Visible label of the first locator of a step ("Guest checkout"). */
function labelOf(actions: readonly ResolvedAction[]): string | null {
  const loc = actions.find((a) => a.locators.length > 0)?.locators[0];
  return loc ? (loc.name ?? loc.value) : null;
}

const pageOf = <T>(rows: T[], page: number) => rows.slice((page - 1) * REVIEW_PAGE_SIZE, page * REVIEW_PAGE_SIZE);

/** Item row shared by `list` for both kinds. */
async function summarizeItem(ctx: Context, item: ReviewItem) {
  const base = {
    id: item.id,
    status: item.status,
    createdAt: item.createdAt ?? null,
    resolvedAt: item.resolvedAt ?? null,
  };
  if (item.kind === 'heal') {
    const p = await ctx.repos.healProposals.get(ctx.db, item.refId);
    if (!p) return undefined;
    const c = await ctx.repos.cases.get(ctx.db, p.caseId);
    const shared = p.sharedStepId ? await ctx.repos.sharedSteps.get(ctx.db, p.sharedStepId) : undefined;
    const before = labelOf(p.before);
    const after = labelOf(p.after);
    const action = c?.steps[p.stepIndex]?.action ?? `Step ${p.stepIndex + 1}`;
    return {
      ...base,
      tab: 'heals' as const,
      caseKey: c?.key ?? p.caseId,
      title: before && after && before !== after ? `“${before}” → “${after}”` : action,
      stepNumber: p.stepIndex + 1,
      confidence: p.confidence,
      sharedStepName: shared?.name ?? null,
      impactCount: p.impactCaseIds.length,
      environment: '',
      browser: null as string | null,
    };
  }
  const result = await ctx.repos.results.getCase(ctx.db, item.refId);
  if (!result) return undefined;
  const c = await ctx.repos.cases.get(ctx.db, result.caseId);
  const env = result.environmentId ? await ctx.repos.environments.get(ctx.db, result.environmentId) : undefined;
  const steps = await ctx.repos.results.listSteps(ctx.db, result.id);
  const uncertain = pickUncertain(steps);
  return {
    ...base,
    tab: 'verdicts' as const,
    caseKey: c?.key ?? result.caseId,
    title: c?.title ?? '',
    stepNumber: uncertain ? uncertain.step.stepIndex + 1 : null,
    confidence: uncertain?.assertion.probability ?? null,
    sharedStepName: null as string | null,
    impactCount: null as number | null,
    environment: env?.name ?? '',
    browser: (result.browser ?? 'chromium') as string | null,
  };
}

type Steps = Awaited<ReturnType<Context['repos']['results']['listSteps']>>;

/** The step and assertion that made the case `needs-review` (else the last assertion with a probability). */
function pickUncertain(steps: Steps) {
  const all = steps.flatMap((step) => step.assertions.map((assertion) => ({ step, assertion })));
  return all.find((x) => x.assertion.verdict === 'needs-review') ?? all.filter((x) => x.assertion.probability !== undefined).at(-1);
}

async function requireItem(ctx: Context, id: string): Promise<ReviewItem> {
  const item = await ctx.repos.reviews.get(ctx.db, id);
  if (!item || item.kind === 'decision') throw new S1PilotError('REVIEW_ITEM_NOT_FOUND', `Review item not found: ${id}`, { id });
  return item;
}

async function pendingIds(ctx: Context, projectId: string, kind: ReviewItem['kind']): Promise<string[]> {
  return (await ctx.repos.reviews.list(ctx.db, { projectId, kind, status: 'pending' })).map((i) => i.id);
}

async function healDetail(ctx: Context, item: ReviewItem, projectKey: string) {
  const p = (await ctx.repos.healProposals.get(ctx.db, item.refId)) as HealProposal | undefined;
  if (!p) throw new S1PilotError('REVIEW_ITEM_NOT_FOUND', `Heal proposal not found: ${item.refId}`, { id: item.id });
  const c = await ctx.repos.cases.get(ctx.db, p.caseId);
  const env = await ctx.repos.environments.get(ctx.db, p.environmentId);
  const shared = p.sharedStepId ? await ctx.repos.sharedSteps.get(ctx.db, p.sharedStepId) : undefined;
  const run = await ctx.repos.runs.get(ctx.db, p.runId);
  const found = run ? (await ctx.repos.results.listCases(ctx.db, run.id)).find((r) => r.caseId === p.caseId) : undefined;
  const impactKeys: string[] = [];
  for (const id of p.impactCaseIds) {
    const ic = await ctx.repos.cases.get(ctx.db, id);
    if (ic) impactKeys.push(ic.key);
  }
  return {
    kind: 'heal' as const,
    item,
    projectKey,
    proposalId: p.id,
    proposalStatus: p.status,
    caseKey: c?.key ?? p.caseId,
    caseTitle: c?.title ?? '',
    stepNumber: p.stepIndex + 1,
    stepAction: c?.steps[p.stepIndex]?.action ?? `Step ${p.stepIndex + 1}`,
    environment: env?.name ?? '',
    runId: p.runId,
    runFound: run !== undefined,
    resultId: found?.id ?? null,
    stepIndex: p.stepIndex,
    browser: found?.browser ?? 'chromium',
    sharedStepName: shared?.name ?? null,
    beforeLabel: labelOf(p.before),
    afterLabel: labelOf(p.after),
    before: actionLines(p.before),
    after: actionLines(p.after),
    confidence: p.confidence,
    s2Agreed: p.s2Agreed ?? null,
    approvedLive: p.approvedLive ?? null,
    impactCount: p.impactCaseIds.length,
    impactCaseKeys: impactKeys,
  };
}

async function verdictDetail(ctx: Context, item: ReviewItem, projectKey: string, projectId: string) {
  const result = await ctx.repos.results.getCase(ctx.db, item.refId);
  if (!result) throw new S1PilotError('REVIEW_ITEM_NOT_FOUND', `Case result not found: ${item.refId}`, { id: item.id });
  const c = await ctx.repos.cases.get(ctx.db, result.caseId);
  const env = result.environmentId ? await ctx.repos.environments.get(ctx.db, result.environmentId) : undefined;
  const steps = await ctx.repos.results.listSteps(ctx.db, result.id);
  const artifacts = await ctx.repos.artifacts.listByCaseResult(ctx.db, result.id);
  const uncertain = pickUncertain(steps);
  const shotStep = uncertain?.step.stepIndex ?? steps.at(-1)?.stepIndex;
  const shot = artifacts.find((a) => a.kind === 'screenshot' && a.stepIndex === shotStep);
  const project = await ctx.repos.projects.get(ctx.db, projectId);
  const settings = project ? await effectiveModelSettings(ctx, project) : undefined;
  const model = [...steps.flatMap((s) => s.decisions)].reverse().find((d) => d.model)?.model ?? null;
  return {
    kind: 'verdict' as const,
    item,
    projectKey,
    resultId: result.id,
    runId: result.runId,
    caseKey: c?.key ?? result.caseId,
    caseTitle: c?.title ?? '',
    environment: env?.name ?? '',
    browser: result.browser ?? 'chromium',
    verdict: result.verdict as Verdict,
    stepNumber: uncertain ? uncertain.step.stepIndex + 1 : null,
    expected: (shotStep !== undefined ? c?.steps[shotStep]?.expected : undefined) ?? uncertain?.assertion.message ?? null,
    pTrue: uncertain?.assertion.probability ?? null,
    thresholds: settings ? { pass: settings.thresholds.pass, fail: settings.thresholds.fail } : null,
    model,
    assertions: steps.flatMap((s) =>
      s.assertions.map((a) => ({
        stepNumber: s.stepIndex + 1,
        assertion: a.assertion,
        verdict: a.verdict,
        probability: a.probability ?? null,
        message: a.message ?? null,
      })),
    ),
    screenshotId: shot?.id ?? null,
  };
}

/** `reviews` router (S-047): counts per tab, paged list, detail and decisions on verdict / heal items. */
export const reviewsRouter = router({
  /** Pending items per tab (what the nav badge sums up). */
  counts: publicProcedure.input(z.object({ projectKey: z.string().min(1) })).query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const pending = await ctx.repos.reviews.list(ctx.db, { projectId: project.id, status: 'pending' });
    const n = (k: ReviewItem['kind']): number => pending.filter((i) => i.kind === k).length;
    return { verdicts: n('verdict'), heals: n('heal'), drafts: await pendingDraftCount(ctx, project.id), visual: 0 };
  }),

  /** One page of a tab. `status` `pending` (default) is the queue; `resolved` is the decided history. */
  list: publicProcedure
    .input(
      z.object({
        projectKey: z.string().min(1),
        tab: TabSchema,
        page: z.number().int().min(1).default(1),
        status: z.enum(['pending', 'resolved']).default('pending'),
      }),
    )
    .query(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.projectKey);
      const kind = KIND_OF_TAB[input.tab];
      const base = { page: input.page, pageSize: REVIEW_PAGE_SIZE };
      if (input.tab === 'drafts') {
        const records = (await syncRecords(ctx, project.id)).filter((r) => (input.status === 'pending' ? !r.outcome : r.outcome !== undefined));
        const rows = input.status === 'pending' ? records : [...records].reverse();
        const items = await Promise.all(pageOf(rows, input.page).map((r) => draftRow(ctx, r)));
        return { ...base, total: rows.length, items };
      }
      if (!kind) return { ...base, total: 0, items: [] };
      const all = await ctx.repos.reviews.list(ctx.db, { projectId: project.id, kind });
      const rows = all.filter((i) => (input.status === 'pending' ? i.status === 'pending' : i.status !== 'pending'));
      const items = (await Promise.all(pageOf(rows, input.page).map((i) => summarizeItem(ctx, i)))).filter((x) => x !== undefined);
      return { ...base, total: rows.length, items };
    }),

  /** Full detail of one item (heal proposal diff or uncertain verdict with evidence). */
  get: publicProcedure.input(IdSchema).query(async ({ ctx, input }) => {
    const item = await requireItem(ctx, input);
    const project = await ctx.repos.projects.get(ctx.db, item.projectId);
    const key = project?.key ?? '';
    return item.kind === 'heal' ? healDetail(ctx, item, key) : verdictDetail(ctx, item, key, item.projectId);
  }),

  /**
   * Decides a pending item. Heal: `approve` (all impacted cases), `approve-case-only`, `reject`. Verdict: `approve`
   * marks the result passed, `reject` marks it failed (or give `verdict`). Returns the decided item and the id of the
   * next pending item of the same tab (for auto-advance).
   */
  decide: publicProcedure
    .input(
      z.object({
        id: IdSchema,
        decision: z.enum(['approve', 'approve-case-only', 'reject']),
        note: z.string().max(2000).default(''),
        verdict: z.enum(['passed', 'failed']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot decide review items');
      const item = await requireItem(ctx, input.id);
      if (item.status !== 'pending') {
        throw new S1PilotError('INVALID_STATE', `Review item is already ${item.status}`, { id: item.id });
      }
      // Approving a heal rewrites the learned script for every case that shares it: leads and admins only.
      if (item.kind === 'heal' && input.decision !== 'reject' && !can(ctx.user.role, 'approvals:decide')) {
        throw new S1PilotError('FORBIDDEN', 'Only leads and admins can approve heal proposals');
      }
      const note = input.note.trim();
      const queue = await pendingIds(ctx, item.projectId, item.kind);
      let decided: ReviewItem;
      if (item.kind === 'heal') {
        if (input.decision === 'reject') await ctx.repos.healProposals.reject(ctx.db, item.refId);
        else {
          await ctx.repos.healProposals.approve(ctx.db, item.refId, {
            scope: input.decision === 'approve' ? 'all' : 'case',
            userId: ctx.user.id,
          });
        }
        decided = note
          ? await ctx.repos.reviews.resolve(ctx.db, item.id, input.decision === 'reject' ? 'rejected' : 'approved', note)
          : ((await ctx.repos.reviews.get(ctx.db, item.id)) as ReviewItem);
        ctx.runtime.live.notifyWorkspace();
      } else {
        if (input.decision === 'approve-case-only') {
          throw new S1PilotError('INVALID_INPUT', 'approve-case-only only applies to heal proposals');
        }
        const result = await ctx.repos.results.getCase(ctx.db, item.refId);
        if (!result) throw new S1PilotError('RESULT_NOT_FOUND', `Result not found: ${item.refId}`, { resultId: item.refId });
        const verdict: 'passed' | 'failed' = input.verdict ?? (input.decision === 'approve' ? 'passed' : 'failed');
        const noteText = `Decided by ${ctx.user.id}: needs-review -> ${verdict}${note ? `. ${note}` : ''}`;
        ({ review: decided } = await applyVerdict(ctx, result, verdict, { noteText, status: verdict === 'passed' ? 'approved' : 'rejected' }));
      }
      const at = queue.indexOf(item.id);
      return { item: decided, nextId: queue[at + 1] ?? queue[at - 1] ?? null };
    }),
});
