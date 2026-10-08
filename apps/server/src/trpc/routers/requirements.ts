import { ProjectKeySchema, S1PilotError, type Requirement } from '@s1pilot/domain';
import { z } from 'zod';

import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireCase, requireProject } from './helpers.js';

async function requireRequirement(ctx: Context, projectId: string, key: string): Promise<Requirement> {
  const r = await ctx.repos.requirements.getByKey(ctx.db, projectId, key);
  if (!r) throw new S1PilotError('REQUIREMENT_NOT_FOUND', `Requirement not found: ${key}`, { key });
  return r;
}

const LinkInput = z.object({ caseKey: z.string().min(1), reqKey: z.string().min(1) });

/**
 * Requirements and their coverage by cases. A link is stored both in `case_requirements` and in the
 * case's `requirements` list (the YAML source of truth), so linking creates a new case version.
 */
export const requirementsRouter = router({
  /** Requirements with the keys of the cases that cover them. */
  list: publicProcedure.input(z.object({ projectKey: ProjectKeySchema })).query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const [reqs, cases] = await Promise.all([
      ctx.repos.requirements.listByProject(ctx.db, project.id),
      ctx.repos.cases.list(ctx.db, { projectId: project.id }),
    ]);
    return reqs.map((r) => {
      const keys = cases
        .filter((c) => r.caseIds.includes(c.id) || c.requirements.includes(r.key))
        .map((c) => c.key);
      return { ...r, caseKeys: keys, coverage: keys.length };
    });
  }),

  /** Creates a requirement; `key` defaults to the next `<PROJECT>-REQ-n`. */
  create: publicProcedure
    .input(
      z.object({
        projectKey: ProjectKeySchema,
        key: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1),
        description: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.projectKey);
      let key = input.key;
      if (key === undefined) {
        const taken = (await ctx.repos.requirements.listByProject(ctx.db, project.id)).map((r) => r.key);
        let n = taken.length + 1;
        while (taken.includes(`${project.key}-REQ-${n}`)) n++;
        key = `${project.key}-REQ-${n}`;
      }
      return ctx.repos.requirements.create(ctx.db, {
        projectId: project.id,
        key,
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    }),

  link: publicProcedure.input(LinkInput).mutation(async ({ ctx, input }) => {
    const c = await requireCase(ctx, input.caseKey);
    const r = await requireRequirement(ctx, c.projectId, input.reqKey);
    await ctx.repos.requirements.link(ctx.db, c.id, r.id);
    const updated = c.requirements.includes(r.key)
      ? c
      : await ctx.repos.cases.update(ctx.db, c.id, { requirements: [...c.requirements, r.key] });
    return { caseKey: updated.key, reqKey: r.key, caseVersion: updated.version };
  }),

  unlink: publicProcedure.input(LinkInput).mutation(async ({ ctx, input }) => {
    const c = await requireCase(ctx, input.caseKey);
    const r = await requireRequirement(ctx, c.projectId, input.reqKey);
    await ctx.repos.requirements.unlink(ctx.db, c.id, r.id);
    const updated = c.requirements.includes(r.key)
      ? await ctx.repos.cases.update(ctx.db, c.id, { requirements: c.requirements.filter((k) => k !== r.key) })
      : c;
    return { caseKey: updated.key, reqKey: r.key, caseVersion: updated.version };
  }),
});
