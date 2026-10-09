import { IdSchema, ProjectKeySchema, S1PilotError, type DraftRecord } from '@s1pilot/domain';
import { z } from 'zod';

import {
  MAX_COUNT,
  MAX_STORY_CHARS,
  acceptDraft,
  discardDraft,
  draftMetrics,
  findDraft,
  generateFromCrawl,
  generateFromStory,
  s2Status,
  syncRecords,
} from '../../generation/service.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireProject } from './helpers.js';

function guard(ctx: Context): void {
  if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot generate or decide test drafts');
}

const caseSummary = (c: { key: string; title: string; version: number; status: string }) => ({ key: c.key, title: c.title, version: c.version, status: c.status });

/** Review-queue row of a draft (same fields as the other tabs, plus `source` and `stepCount`). */
export async function draftRow(ctx: Context, r: DraftRecord) {
  const c = await ctx.repos.cases.get(ctx.db, r.caseId);
  return {
    id: r.caseId,
    status: r.outcome === undefined ? ('pending' as const) : r.outcome === 'discarded' ? ('rejected' as const) : ('approved' as const),
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt ?? null,
    tab: 'drafts' as const,
    caseKey: r.caseKey,
    title: c?.title ?? r.title,
    stepNumber: null as number | null,
    confidence: null as number | null,
    sharedStepName: null as string | null,
    impactCount: null as number | null,
    environment: '',
    browser: null as string | null,
    source: r.source,
    stepCount: c?.steps.length ?? 0,
  };
}

/** System 2 test generation (S-061): from a story or a crawl, plus the draft decisions behind the review tab. */
export const generateRouter = router({
  /** Whether System 2 is configured (the UI disables generation otherwise). */
  status: publicProcedure.input(z.object({ projectKey: ProjectKeySchema })).query(async ({ ctx, input }) => {
    return s2Status(ctx, await requireProject(ctx, input.projectKey));
  }),

  /** Drafts test cases from a user story / acceptance criteria. Nothing is saved when System 2's output is unusable. */
  fromStory: publicProcedure
    .input(
      z.object({
        projectKey: ProjectKeySchema,
        storyText: z.string().trim().min(1, 'Write or paste a story').max(MAX_STORY_CHARS),
        requirementKey: z.string().min(1).optional(),
        count: z.number().int().min(1).max(MAX_COUNT).optional(),
        suiteId: IdSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      guard(ctx);
      const { projectKey, ...rest } = input;
      const cases = await generateFromStory(ctx, await requireProject(ctx, projectKey), rest);
      return { cases: cases.map(caseSummary) };
    }),

  /** Crawls the environment read-only (same host plus allowed domains) and drafts smoke tests from what it finds. */
  fromCrawl: publicProcedure
    .input(
      z.object({
        projectKey: ProjectKeySchema,
        environment: z.string().min(1).optional(),
        maxPages: z.number().int().min(1).max(20).default(20),
        suiteId: IdSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      guard(ctx);
      const { projectKey, ...rest } = input;
      const out = await generateFromCrawl(ctx, await requireProject(ctx, projectKey), rest);
      return { cases: out.cases.map(caseSummary), pagesVisited: out.pagesVisited, skipped: out.skipped };
    }),

  /** One draft with its steps for the read-only preview. */
  draft: publicProcedure.input(IdSchema).query(async ({ ctx, input }) => {
    const { project, record, case: c } = await findDraft(ctx, input);
    return {
      id: record.caseId,
      projectKey: project.key,
      caseKey: record.caseKey,
      title: c?.title ?? record.title,
      source: record.source,
      requirementKey: record.requirementKey ?? null,
      outcome: record.outcome ?? null,
      resolvedAt: record.resolvedAt ?? null,
      createdAt: record.createdAt,
      /** True when the case changed since it was generated. */
      edited: c !== undefined && c.version > record.createdVersion,
      priority: c?.priority ?? null,
      type: c?.type ?? null,
      tags: c?.tags ?? [],
      steps: (c?.steps ?? []).map((s) => ({ action: s.action, expected: s.expected ?? null })),
    };
  }),

  /** Accepts a draft: it becomes `ready` and counts as accepted as-is or edited. */
  accept: publicProcedure.input(z.object({ id: IdSchema })).mutation(async ({ ctx, input }) => {
    guard(ctx);
    const next = await nextPendingId(ctx, input.id);
    return { record: await acceptDraft(ctx, input.id), nextId: next };
  }),

  /** Discards a draft (the case is deleted; the decision is counted). */
  discard: publicProcedure.input(z.object({ id: IdSchema })).mutation(async ({ ctx, input }) => {
    guard(ctx);
    const next = await nextPendingId(ctx, input.id);
    return { record: await discardDraft(ctx, input.id), nextId: next };
  }),

  /** Acceptance metrics of the generated drafts (P5 exit criterion). */
  metrics: publicProcedure.input(z.object({ projectKey: ProjectKeySchema })).query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    return draftMetrics(ctx, project.id);
  }),
});

/** Id of the pending draft next to `id` (for auto-advance), or null. */
async function nextPendingId(ctx: Context, id: string): Promise<string | null> {
  const { project } = await findDraft(ctx, id);
  const pending = (await syncRecords(ctx, project.id)).filter((r) => !r.outcome).map((r) => r.caseId);
  const at = pending.indexOf(id);
  return pending[at + 1] ?? pending[at - 1] ?? null;
}
