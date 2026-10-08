import { IdSchema, ProjectKeySchema, S1PilotError, newId, type Suite } from '@s1pilot/domain';
import { z } from 'zod';

import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireProject, requireSuite, requireSuiteIn } from './helpers.js';

/** A suite with its children and case counts. */
export interface SuiteNode {
  id: string;
  name: string;
  parentId?: string;
  position: number;
  /** Cases directly in this suite. */
  caseCount: number;
  /** Cases in this suite and all descendants. */
  totalCount: number;
  children: SuiteNode[];
}

/** Ids of `rootId` and all of its descendants. */
export function subtreeIds(all: Suite[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of all) {
      if (s.parentId !== undefined && ids.has(s.parentId) && !ids.has(s.id)) {
        ids.add(s.id);
        grew = true;
      }
    }
  }
  return ids;
}

async function projectSuites(ctx: Context, projectId: string): Promise<Suite[]> {
  return ctx.repos.suites.listByProject(ctx.db, projectId);
}

const NameSchema = z.string().trim().min(1);

/** Nestable suites (folders) of a project. */
export const suitesRouter = router({
  /** Nested tree with case counts, plus the number of cases not in any suite. */
  tree: publicProcedure.input(z.object({ projectKey: ProjectKeySchema })).query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const [suites, cases] = await Promise.all([
      projectSuites(ctx, project.id),
      ctx.repos.cases.list(ctx.db, { projectId: project.id }),
    ]);
    const direct = new Map<string, number>();
    let unsorted = 0;
    for (const c of cases) {
      if (c.suiteId === undefined) unsorted++;
      else direct.set(c.suiteId, (direct.get(c.suiteId) ?? 0) + 1);
    }
    const build = (parentId: string | undefined, depth: number): SuiteNode[] =>
      depth > 64
        ? []
        : suites
            .filter((s) => s.parentId === parentId)
            .map((s) => {
              const children = build(s.id, depth + 1);
              const caseCount = direct.get(s.id) ?? 0;
              return {
                id: s.id,
                name: s.name,
                ...(s.parentId !== undefined ? { parentId: s.parentId } : {}),
                position: s.position,
                caseCount,
                totalCount: caseCount + children.reduce((n, c) => n + c.totalCount, 0),
                children,
              };
            });
    return { tree: build(undefined, 0), totalCases: cases.length, unsortedCases: unsorted };
  }),

  create: publicProcedure
    .input(z.object({ projectKey: ProjectKeySchema, name: NameSchema, parentId: IdSchema.optional() }))
    .mutation(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.projectKey);
      if (input.parentId !== undefined) await requireSuiteIn(ctx, input.parentId, project.id);
      const siblings = (await projectSuites(ctx, project.id)).filter((s) => s.parentId === input.parentId);
      return ctx.repos.suites.create(ctx.db, {
        id: newId(),
        projectId: project.id,
        name: input.name,
        position: siblings.length,
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
      });
    }),

  rename: publicProcedure.input(z.object({ id: IdSchema, name: NameSchema })).mutation(async ({ ctx, input }) => {
    await requireSuite(ctx, input.id);
    return ctx.repos.suites.update(ctx.db, input.id, { name: input.name });
  }),

  /** Re-parents a suite (`parentId: null` = top level). Moving into itself or a descendant is rejected. */
  move: publicProcedure
    .input(z.object({ id: IdSchema, parentId: IdSchema.nullable(), position: z.number().int().min(0).optional() }))
    .mutation(async ({ ctx, input }) => {
      const suite = await requireSuite(ctx, input.id);
      const all = await projectSuites(ctx, suite.projectId);
      if (input.parentId !== null) {
        await requireSuiteIn(ctx, input.parentId, suite.projectId);
        if (subtreeIds(all, suite.id).has(input.parentId)) {
          throw new S1PilotError('INVALID_MOVE', 'A suite cannot be moved into itself or its own sub-suites', {
            id: input.id,
            parentId: input.parentId,
          });
        }
      }
      const parentId = input.parentId ?? undefined;
      const position =
        input.position ?? all.filter((s) => s.parentId === parentId && s.id !== suite.id).length;
      return ctx.repos.suites.update(ctx.db, suite.id, { parentId, position });
    }),

  /**
   * Deletes a suite and its sub-suites. Fails with `INVALID_STATE` when cases remain in the subtree
   * unless `moveCasesTo` names another suite (or `null` for "no suite").
   */
  delete: publicProcedure
    .input(z.object({ id: IdSchema, moveCasesTo: IdSchema.nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const suite = await requireSuite(ctx, input.id);
      const all = await projectSuites(ctx, suite.projectId);
      const doomed = subtreeIds(all, suite.id);
      const cases = (await ctx.repos.cases.list(ctx.db, { projectId: suite.projectId })).filter(
        (c) => c.suiteId !== undefined && doomed.has(c.suiteId),
      );
      let moved = 0;
      if (cases.length > 0) {
        if (input.moveCasesTo === undefined) {
          throw new S1PilotError('INVALID_STATE', `Suite "${suite.name}" still contains ${cases.length} case(s)`, {
            id: suite.id,
            caseCount: cases.length,
          });
        }
        if (input.moveCasesTo !== null) {
          await requireSuiteIn(ctx, input.moveCasesTo, suite.projectId);
          if (doomed.has(input.moveCasesTo)) {
            throw new S1PilotError('INVALID_MOVE', 'moveCasesTo must be outside the suite being deleted', {
              moveCasesTo: input.moveCasesTo,
            });
          }
        }
        const target = input.moveCasesTo ?? undefined;
        for (const c of cases) await ctx.repos.cases.update(ctx.db, c.id, { suiteId: target });
        moved = cases.length;
      }
      await ctx.repos.suites.delete(ctx.db, suite.id);
      return { deleted: true as const, id: suite.id, movedCases: moved };
    }),
});
