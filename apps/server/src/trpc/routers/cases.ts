import {
  IdSchema,
  ProjectKeySchema,
  S1PilotError,
  TestCaseFileSchema,
  TestCaseStatusSchema,
  matchesCaseQuery,
  parseCaseQuery,
  type CaseResult,
  type Priority,
  type Project,
  type SharedStep,
  type Suite,
  type TestCase,
} from '@s1pilot/domain';
import { caseToYaml, parseCaseYaml, unifiedDiff } from '@s1pilot/sync';
import { z } from 'zod';

import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { requireCase, requireKnownUser, requireProject, requireSuiteIn } from './helpers.js';

/** Content fields of a case (everything except the key, which the server allocates). */
const CaseContentSchema = TestCaseFileSchema.omit({ key: true });

const CreateInput = CaseContentSchema.extend({
  projectKey: ProjectKeySchema,
  suiteId: IdSchema.optional(),
});

const PatchSchema = CaseContentSchema.partial().extend({ suiteId: IdSchema.nullable().optional() });

const SortSchema = z.object({
  by: z.enum(['key', 'title', 'priority', 'status', 'updatedAt']).default('key'),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

export type LearnedStatus = 'none' | 'current' | 'stale' | 'needs-review';

/** Learned-script state of a case in one environment. */
export interface LearnedInfo {
  environmentId: string;
  environmentName: string;
  status: LearnedStatus;
  caseVersion?: number;
  healCount?: number;
  pendingProposals?: number;
  lastReplayedAt?: string;
}

/** Last result of a case, as shown in the list. */
export interface LastResult {
  runId: string;
  verdict: CaseResult['verdict'];
  mode: CaseResult['mode'];
  caseVersion: number;
  environmentId?: string;
  startedAt?: string;
  durationMs: number;
}

async function learnedFor(ctx: Context, c: TestCase, envs: { id: string; name: string }[]): Promise<LearnedInfo[]> {
  const scripts = await ctx.repos.learnedScripts.listByCase(ctx.db, c.id);
  return envs.map((env) => {
    const s = scripts.find((x) => x.environmentId === env.id);
    if (!s) return { environmentId: env.id, environmentName: env.name, status: 'none' as const };
    const status: LearnedStatus =
      s.health.pendingProposals > 0 ? 'needs-review' : s.caseVersion === c.version ? 'current' : 'stale';
    return {
      environmentId: env.id,
      environmentName: env.name,
      status,
      caseVersion: s.caseVersion,
      healCount: s.health.healCount,
      pendingProposals: s.health.pendingProposals,
      ...(s.health.lastReplayedAt !== undefined ? { lastReplayedAt: s.health.lastReplayedAt } : {}),
    };
  });
}

function toLastResult(r: (CaseResult & { startedAt?: string }) | undefined): LastResult | null {
  if (!r) return null;
  return {
    runId: r.runId,
    verdict: r.verdict,
    mode: r.mode,
    caseVersion: r.caseVersion,
    ...(r.environmentId !== undefined ? { environmentId: r.environmentId } : {}),
    ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
    durationMs: r.durationMs,
  };
}

function suitePathOf(suites: Suite[], id: string | undefined): { id: string; name: string }[] {
  const byId = new Map(suites.map((s) => [s.id, s]));
  const out: { id: string; name: string }[] = [];
  for (let cur = id === undefined ? undefined : byId.get(id), n = 0; cur && n < 64; n++) {
    out.unshift({ id: cur.id, name: cur.name });
    cur = cur.parentId === undefined ? undefined : byId.get(cur.parentId);
  }
  return out;
}

/** Ids of `suiteId` and its descendants. */
function suiteScope(suites: Suite[], suiteId: string): Set<string> {
  const ids = new Set([suiteId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of suites) {
      if (s.parentId !== undefined && ids.has(s.parentId) && !ids.has(s.id)) {
        ids.add(s.id);
        grew = true;
      }
    }
  }
  return ids;
}

async function flowMaps(ctx: Context, projectId: string) {
  const flows: SharedStep[] = await ctx.repos.sharedSteps.listByProject(ctx.db, projectId);
  return {
    nameById: new Map(flows.map((f) => [f.id, f.name])),
    idByName: new Map(flows.map((f) => [f.name, f.id])),
  };
}

async function projectOfCase(ctx: Context, c: TestCase): Promise<Project> {
  const p = await ctx.repos.projects.get(ctx.db, c.projectId);
  if (!p) throw new S1PilotError('PROJECT_NOT_FOUND', `Project not found: ${c.projectId}`, { id: c.projectId });
  return p;
}

const prioRank = (p: Priority): number => Number(p.slice(1));

/** Removes deleted cases from plans that list cases by id, so those plans stay valid and can still be saved. */
async function dropFromPlans(ctx: Context, deleted: TestCase[]): Promise<void> {
  const gone = new Set(deleted.map((c) => c.id));
  for (const projectId of new Set(deleted.map((c) => c.projectId))) {
    for (const plan of await ctx.repos.plans.listByProject(ctx.db, projectId)) {
      if (plan.selection.kind !== 'list' || !plan.selection.caseIds.some((id) => gone.has(id))) continue;
      await ctx.repos.plans.update(ctx.db, plan.id, {
        selection: { kind: 'list', caseIds: plan.selection.caseIds.filter((id) => !gone.has(id)) },
      });
    }
  }
}

const BulkInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('move'), suiteId: IdSchema.nullable() }),
  z.object({
    action: z.literal('tag'),
    add: z.array(z.string().trim().min(1)).default([]),
    remove: z.array(z.string().trim().min(1)).default([]),
  }),
  z.object({ action: z.literal('setStatus'), status: TestCaseStatusSchema }),
  z.object({ action: z.literal('delete') }),
]);

/** Test cases: list/filter, CRUD with optimistic concurrency, history, diff and YAML. */
export const casesRouter = router({
  /**
   * Filtered, sorted, paged list. `query` uses the case query language (`tags:`, `priority<=`,
   * `status:`, `owner:`, free text); `suiteId` includes sub-suites.
   */
  list: publicProcedure
    .input(
      z.object({
        projectKey: ProjectKeySchema,
        suiteId: IdSchema.optional(),
        query: z.string().optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(200).default(25),
        sort: SortSchema.default({}),
      }),
    )
    .query(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.projectKey);
      const [all, suites, envs] = await Promise.all([
        ctx.repos.cases.list(ctx.db, { projectId: project.id }),
        ctx.repos.suites.listByProject(ctx.db, project.id),
        ctx.repos.environments.listByProject(ctx.db, project.id),
      ]);
      const parsed = input.query?.trim() ? parseCaseQuery(input.query) : undefined;
      const scope = input.suiteId !== undefined ? suiteScope(suites, input.suiteId) : undefined;
      const matched = all.filter(
        (c) =>
          (!scope || (c.suiteId !== undefined && scope.has(c.suiteId))) && (!parsed || matchesCaseQuery(c, parsed)),
      );
      const dir = input.sort.dir === 'asc' ? 1 : -1;
      const by = input.sort.by;
      matched.sort((a, b) => {
        let cmp: number;
        if (by === 'priority') cmp = prioRank(a.priority) - prioRank(b.priority);
        else if (by === 'title') cmp = a.title.localeCompare(b.title);
        else if (by === 'status') cmp = a.status.localeCompare(b.status);
        else if (by === 'updatedAt') cmp = (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '');
        else cmp = Number(a.key.split('-TC-')[1]) - Number(b.key.split('-TC-')[1]);
        return cmp !== 0 ? cmp * dir : Number(a.key.split('-TC-')[1]) - Number(b.key.split('-TC-')[1]);
      });
      const start = (input.page - 1) * input.pageSize;
      const pageCases = matched.slice(start, start + input.pageSize);
      const last = await ctx.repos.results.lastByCases(
        ctx.db,
        pageCases.map((c) => c.id),
      );
      const items = await Promise.all(
        pageCases.map(async (c) => {
          const { steps, ...rest } = c;
          return {
            ...rest,
            stepCount: steps.length,
            suitePath: suitePathOf(suites, c.suiteId),
            learned: await learnedFor(ctx, c, envs),
            lastResult: toLastResult(last.get(c.id)),
          };
        }),
      );
      return { items, total: matched.length, page: input.page, pageSize: input.pageSize };
    }),

  /** One case with suite path, learned-script status per environment and last result. */
  get: publicProcedure.input(z.object({ key: z.string().min(1) }).or(z.string().min(1))).query(async ({ ctx, input }) => {
    const c = await requireCase(ctx, typeof input === 'string' ? input : input.key);
    const [suites, envs, last] = await Promise.all([
      ctx.repos.suites.listByProject(ctx.db, c.projectId),
      ctx.repos.environments.listByProject(ctx.db, c.projectId),
      ctx.repos.results.lastByCases(ctx.db, [c.id]),
    ]);
    return {
      ...c,
      suitePath: suitePathOf(suites, c.suiteId),
      learned: await learnedFor(ctx, c, envs),
      lastResult: toLastResult(last.get(c.id)),
    };
  }),

  /** Creates a case (version 1) and allocates its `KEY-TC-n`. */
  create: publicProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const { projectKey, ...content } = input;
    const project = await requireProject(ctx, projectKey);
    await requireKnownUser(ctx, content.owner);
    if (content.suiteId !== undefined) await requireSuiteIn(ctx, content.suiteId, project.id);
    return ctx.repos.cases.create(ctx.db, project.id, content);
  }),

  /**
   * Applies `patch` and bumps the version. `expectedVersion` must equal the stored version, else
   * `CONFLICT` (nothing is written). `suiteId: null` removes the case from its suite.
   */
  update: publicProcedure
    .input(z.object({ key: z.string().min(1), expectedVersion: z.number().int().min(1), patch: PatchSchema }))
    .mutation(async ({ ctx, input }) => {
      const c = await requireCase(ctx, input.key);
      const { suiteId, ...rest } = input.patch;
      await requireKnownUser(ctx, rest.owner);
      if (suiteId) await requireSuiteIn(ctx, suiteId, c.projectId);
      return ctx.repos.cases.update(
        ctx.db,
        c.id,
        { ...rest, ...(suiteId !== undefined ? { suiteId: suiteId ?? undefined } : {}) },
        { expectedVersion: input.expectedVersion },
      );
    }),

  /** Bulk move / tag / setStatus / delete over case ids. All ids are validated before anything changes. */
  bulk: publicProcedure
    .input(z.object({ ids: z.array(IdSchema).min(1).max(500) }).and(BulkInput))
    .mutation(async ({ ctx, input }) => {
      const cases: TestCase[] = [];
      for (const id of new Set(input.ids)) {
        const c = await ctx.repos.cases.get(ctx.db, id);
        if (!c) throw new S1PilotError('CASE_NOT_FOUND', `Case not found: ${id}`, { id });
        cases.push(c);
      }
      if (input.action === 'delete' && ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot delete cases');
      if (input.action === 'move' && input.suiteId !== null) {
        for (const projectId of new Set(cases.map((c) => c.projectId))) {
          await requireSuiteIn(ctx, input.suiteId, projectId);
        }
      }
      for (const c of cases) {
        if (input.action === 'move') {
          await ctx.repos.cases.update(ctx.db, c.id, { suiteId: input.suiteId ?? undefined });
        } else if (input.action === 'tag') {
          const tags = [...new Set([...c.tags, ...input.add])].filter((t) => !input.remove.includes(t));
          await ctx.repos.cases.update(ctx.db, c.id, { tags });
        } else if (input.action === 'setStatus') {
          await ctx.repos.cases.update(ctx.db, c.id, { status: input.status });
        } else {
          await ctx.repos.cases.delete(ctx.db, c.id);
        }
      }
      if (input.action === 'delete') await dropFromPlans(ctx, cases);
      return { action: input.action, affected: cases.length, keys: cases.map((c) => c.key) };
    }),

  /**
   * Quarantines a case: plan runs skip it (reported as `skipped (quarantined)`) unless they include quarantined
   * cases. Listed at `cases.list({ query: 'quarantined:yes' })`. Does not change the case version.
   */
  quarantine: publicProcedure
    .input(z.object({ key: z.string().min(1), reason: z.string().trim().min(1, 'A reason is required').max(500) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot quarantine cases');
      const c = await requireCase(ctx, input.key);
      return ctx.repos.cases.setQuarantine(ctx.db, c.id, input.reason);
    }),

  /** Lifts the quarantine of a case. `reason` (optional) is kept in the server log only. */
  unquarantine: publicProcedure
    .input(z.object({ key: z.string().min(1), reason: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot change quarantine');
      const c = await requireCase(ctx, input.key);
      ctx.log?.info({ key: c.key, reason: input.reason }, 'case unquarantined');
      return ctx.repos.cases.setQuarantine(ctx.db, c.id, null);
    }),

  /** Flakiest cases of a project (score over the last 20 executions per environment and browser), most flaky first. */
  flaky: publicProcedure
    .input(z.object({ projectKey: ProjectKeySchema, limit: z.number().int().min(1).max(200).default(20) }))
    .query(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.projectKey);
      const list = await ctx.repos.cases.listFlaky(ctx.db, project.id, input.limit);
      return list.map((c) => ({ id: c.id, key: c.key, title: c.title, priority: c.priority, status: c.status, flakiness: c.flakiness ?? 0, quarantined: c.quarantined ?? false }));
    }),

  /** All versions of a case, newest first (full snapshots). */
  history: publicProcedure.input(z.object({ key: z.string().min(1) })).query(async ({ ctx, input }) => {
    const c = await requireCase(ctx, input.key);
    return ctx.repos.cases.history(ctx.db, c.id);
  }),

  /**
   * Unified step-level diff between two versions (rendered as the case YAML, one block per step),
   * plus a per-step summary.
   */
  diff: publicProcedure
    .input(z.object({ key: z.string().min(1), fromVersion: z.number().int().min(1), toVersion: z.number().int().min(1) }))
    .query(async ({ ctx, input }) => {
      const c = await requireCase(ctx, input.key);
      const history = await ctx.repos.cases.history(ctx.db, c.id);
      const find = (v: number): TestCase => {
        const found = history.find((h) => h.version === v);
        if (!found) throw new S1PilotError('VERSION_NOT_FOUND', `${c.key} has no version ${v}`, { key: c.key, version: v });
        return found;
      };
      const from = find(input.fromVersion);
      const to = find(input.toVersion);
      const { nameById } = await flowMaps(ctx, c.projectId);
      const render = (x: TestCase): string => caseToYaml(x, { flowNameById: nameById, withVersion: false });
      const unified = unifiedDiff(render(from), render(to), `${c.key}@v${from.version}`, `${c.key}@v${to.version}`);
      const steps: { index: number; change: 'added' | 'removed' | 'changed' | 'unchanged'; before?: unknown; after?: unknown }[] = [];
      for (let i = 0; i < Math.max(from.steps.length, to.steps.length); i++) {
        const before = from.steps[i];
        const after = to.steps[i];
        if (before && !after) steps.push({ index: i, change: 'removed', before });
        else if (!before && after) steps.push({ index: i, change: 'added', after });
        else if (JSON.stringify(before) === JSON.stringify(after)) steps.push({ index: i, change: 'unchanged' });
        else steps.push({ index: i, change: 'changed', before, after });
      }
      return { key: c.key, fromVersion: from.version, toVersion: to.version, unified, steps };
    }),

  /** The case as YAML (same format as tests-as-code export, including `version:`). */
  yaml: publicProcedure.input(z.object({ key: z.string().min(1) })).query(async ({ ctx, input }) => {
    const c = await requireCase(ctx, input.key);
    const { nameById } = await flowMaps(ctx, c.projectId);
    return { key: c.key, version: c.version, yaml: caseToYaml(c, { flowNameById: nameById }) };
  }),

  /**
   * Replaces the case content from YAML. The base version is `expectedVersion`, else the YAML's
   * `version:`, else the current one. Content identical to the stored case is a no-op (no version bump).
   */
  updateFromYaml: publicProcedure
    .input(z.object({ key: z.string().min(1), yaml: z.string().min(1), expectedVersion: z.number().int().min(1).optional() }))
    .mutation(async ({ ctx, input }) => {
      const c = await requireCase(ctx, input.key);
      const project = await projectOfCase(ctx, c);
      const { nameById, idByName } = await flowMaps(ctx, project.id);
      let parsed;
      try {
        parsed = parseCaseYaml(input.yaml, idByName);
      } catch (error) {
        if (error instanceof S1PilotError && error.code === 'SYNC_REFERENCE') {
          throw new S1PilotError('INVALID_FLOW_REFERENCE', error.message, error.details);
        }
        throw error;
      }
      const { file } = parsed;
      await requireKnownUser(ctx, file.owner);
      if (file.key !== c.key) {
        throw new S1PilotError('INVALID_CASE_KEY', `YAML key ${file.key} does not match ${c.key}`, { key: c.key, yamlKey: file.key });
      }
      const expectedVersion = input.expectedVersion ?? parsed.version ?? c.version;
      if (expectedVersion !== c.version) {
        throw new S1PilotError('CONFLICT', `Case ${c.key} is at v${c.version}, YAML is based on v${expectedVersion}`, {
          key: c.key,
          expectedVersion,
          currentVersion: c.version,
        });
      }
      const next: TestCase = { ...c, ...file, key: c.key, owner: file.owner };
      const render = (x: TestCase): string => caseToYaml(x, { flowNameById: nameById, withVersion: false });
      if (render(next) === render(c)) return c;
      const { key, ...content } = file;
      void key;
      return ctx.repos.cases.update(ctx.db, c.id, { ...content, owner: file.owner }, { expectedVersion });
    }),
});
