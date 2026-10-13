import { datasetBaseName } from '@s1pilot/db';
import { IdSchema, ProjectKeySchema, S1PilotError, newId, type TestDataSet } from '@s1pilot/domain';
import { parseCsv } from '@s1pilot/sync';
import { z } from 'zod';

import { publicProcedure, router } from '../trpc.js';

import { requireEnvironment, requireProject } from './helpers.js';

/** Largest accepted file (characters); keeps the JSON request under Fastify's 1 MiB body limit. */
export const MAX_DATASET_CHARS = 900_000;

const RowsSchema = z.array(z.record(z.union([z.string(), z.number(), z.boolean()])));

/** Parses an uploaded `.csv` (header row + rows) or `.json` (array of flat objects) file. */
export function parseDatasetFile(fileName: string, content: string): TestDataSet['rows'] {
  if (/\.csv$/i.test(fileName)) {
    const rows = parseCsv(content);
    if (rows.length === 0) throw new S1PilotError('DATASET_INVALID', `${fileName} has a header but no data rows`);
    return rows;
  }
  if (/\.json$/i.test(fileName)) {
    let doc: unknown;
    try {
      doc = JSON.parse(content);
    } catch (error) {
      throw new S1PilotError('DATASET_INVALID', `${fileName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = RowsSchema.safeParse(doc);
    if (!parsed.success) throw new S1PilotError('DATASET_INVALID', `${fileName} must be an array of flat objects`);
    if (parsed.data.length === 0) throw new S1PilotError('DATASET_INVALID', `${fileName} has no rows`);
    return parsed.data;
  }
  throw new S1PilotError('DATASET_INVALID', 'Upload a .csv or .json file');
}

/** Test data sets that parameterised cases reference with `dataset: <name>` (S-026, S-042). */
export const datasetsRouter = router({
  /** Data sets of a project with row counts and how many cases reference each. */
  list: publicProcedure.input(z.object({ projectKey: ProjectKeySchema })).query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const [sets, cases, envs] = await Promise.all([
      ctx.repos.datasets.listByProject(ctx.db, project.id),
      ctx.repos.cases.list(ctx.db, { projectId: project.id }),
      ctx.repos.environments.listByProject(ctx.db, project.id),
    ]);
    const envName = new Map(envs.map((e) => [e.id, e.name]));
    return sets.map((s) => ({
      id: s.id,
      name: s.name,
      rows: s.rows.length,
      environment: s.environmentId !== undefined ? (envName.get(s.environmentId) ?? null) : null,
      usedBy: cases.filter((c) => c.parameters.some((p) => typeof p['dataset'] === 'string' && datasetBaseName(p['dataset']) === s.name)).length,
    }));
  }),

  /** Creates a data set from a CSV/JSON file, or replaces the rows of the set with the same name and scope. */
  upload: publicProcedure
    .input(
      z.object({
        projectKey: ProjectKeySchema,
        fileName: z.string().min(1).max(200),
        content: z.string().max(MAX_DATASET_CHARS, 'File is too large (max ~900 KB)'),
        environmentId: IdSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const project = await requireProject(ctx, input.projectKey);
      if (input.environmentId !== undefined) {
        const env = await requireEnvironment(ctx, input.environmentId);
        if (env.projectId !== project.id) throw new S1PilotError('ENVIRONMENT_NOT_FOUND', `Environment not found: ${input.environmentId}`);
      }
      const name = datasetBaseName(input.fileName.split(/[\\/]/).pop() ?? input.fileName);
      if (!/^[\w.-]+$/.test(name)) throw new S1PilotError('DATASET_INVALID', 'Use letters, digits, dot, dash or underscore in the file name');
      const rows = parseDatasetFile(input.fileName, input.content);
      const saved = await ctx.repos.datasets.upsert(ctx.db, {
        id: newId(),
        projectId: project.id,
        name,
        rows,
        ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
      });
      return { id: saved.id, name: saved.name, rows: saved.rows.length };
    }),
});
