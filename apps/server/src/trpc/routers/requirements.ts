import { IdSchema, ProjectKeySchema, S1PilotError, type Requirement, type TestCase } from '@s1pilot/domain';
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
const RefInput = z.object({ projectKey: ProjectKeySchema, key: z.string().min(1) });
/** Requirement keys appear in case YAML: letters, digits, `.`, `_`, `-`; no spaces. */
const KeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use letters, digits, ".", "_" or "-" (no spaces), for example SHOP-REQ-7')
  .max(64);

function requireWriter(ctx: Context): void {
  if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot change requirements');
}

/** Links `c` to `r` in both places (link table and the case's `requirements` list). */
async function linkCase(ctx: Context, c: TestCase, r: Requirement): Promise<TestCase> {
  await ctx.repos.requirements.link(ctx.db, c.id, r.id);
  return c.requirements.includes(r.key) ? c : ctx.repos.cases.update(ctx.db, c.id, { requirements: [...c.requirements, r.key] });
}

/** Removes the link of `c` to `r` from both places. */
async function unlinkCase(ctx: Context, c: TestCase, r: Requirement): Promise<TestCase> {
  await ctx.repos.requirements.unlink(ctx.db, c.id, r.id);
  return c.requirements.includes(r.key) ? ctx.repos.cases.update(ctx.db, c.id, { requirements: c.requirements.filter((k) => k !== r.key) }) : c;
}

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
      const covering = cases.filter((c) => r.caseIds.includes(c.id) || c.requirements.includes(r.key));
      // `coveringCaseIds` also counts cases that list the key only in their YAML (no link row).
      return { ...r, caseKeys: covering.map((c) => c.key), coveringCaseIds: covering.map((c) => c.id), coverage: covering.length };
    });
  }),

  /** Creates a requirement; `key` defaults to the next `<PROJECT>-REQ-n`. */
  create: publicProcedure
    .input(
      z.object({
        projectKey: ProjectKeySchema,
        key: KeySchema.optional(),
        title: z.string().trim().min(1, 'Enter a title').max(300),
        description: z.string().trim().max(5000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireWriter(ctx);
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
        ...(input.description ? { description: input.description } : {}),
      });
    }),

  /** Changes title / description; the key is fixed (case YAML refers to it). */
  update: publicProcedure
    .input(
      RefInput.extend({
        patch: z.object({ title: z.string().trim().min(1, 'Enter a title').max(300).optional(), description: z.string().trim().max(5000).nullable().optional() }),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      requireWriter(ctx);
      const project = await requireProject(ctx, input.projectKey);
      const r = await requireRequirement(ctx, project.id, input.key);
      const { title, description } = input.patch;
      return ctx.repos.requirements.update(ctx.db, r.id, {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description: description === '' ? null : description } : {}),
      });
    }),

  /** Deletes a requirement and removes its key from every case that lists it (the cases stay). */
  delete: publicProcedure.input(RefInput).mutation(async ({ ctx, input }) => {
    requireWriter(ctx);
    const project = await requireProject(ctx, input.projectKey);
    const r = await requireRequirement(ctx, project.id, input.key);
    const cases = await ctx.repos.cases.list(ctx.db, { projectId: project.id });
    for (const c of cases) if (c.requirements.includes(r.key) || r.caseIds.includes(c.id)) await unlinkCase(ctx, c, r);
    await ctx.repos.requirements.delete(ctx.db, r.id);
    return { key: r.key, unlinked: cases.filter((c) => c.requirements.includes(r.key) || r.caseIds.includes(c.id)).length };
  }),

  /**
   * Makes exactly `caseIds` cover the requirement: links the new ones, unlinks the others. Every case must
   * belong to the project; nothing changes otherwise.
   */
  setCases: publicProcedure
    .input(RefInput.extend({ caseIds: z.array(IdSchema).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      requireWriter(ctx);
      const project = await requireProject(ctx, input.projectKey);
      const r = await requireRequirement(ctx, project.id, input.key);
      const wanted = new Set(input.caseIds);
      for (const id of wanted) {
        const c = await ctx.repos.cases.get(ctx.db, id);
        if (!c || c.projectId !== project.id) throw new S1PilotError('CASE_NOT_FOUND', `Case not found in project: ${id}`, { id });
      }
      const cases = await ctx.repos.cases.list(ctx.db, { projectId: project.id });
      let added = 0;
      let removed = 0;
      for (const c of cases) {
        const covers = c.requirements.includes(r.key) || r.caseIds.includes(c.id);
        if (wanted.has(c.id) && !(c.requirements.includes(r.key) && r.caseIds.includes(c.id))) {
          await linkCase(ctx, c, r);
          if (!covers) added++;
        } else if (!wanted.has(c.id) && covers) {
          await unlinkCase(ctx, c, r);
          removed++;
        }
      }
      return { key: r.key, added, removed };
    }),

  link: publicProcedure.input(LinkInput).mutation(async ({ ctx, input }) => {
    requireWriter(ctx);
    const c = await requireCase(ctx, input.caseKey);
    const r = await requireRequirement(ctx, c.projectId, input.reqKey);
    const updated = await linkCase(ctx, c, r);
    return { caseKey: updated.key, reqKey: r.key, caseVersion: updated.version };
  }),

  unlink: publicProcedure.input(LinkInput).mutation(async ({ ctx, input }) => {
    requireWriter(ctx);
    const c = await requireCase(ctx, input.caseKey);
    const r = await requireRequirement(ctx, c.projectId, input.reqKey);
    const updated = await unlinkCase(ctx, c, r);
    return { caseKey: updated.key, reqKey: r.key, caseVersion: updated.version };
  }),
});
