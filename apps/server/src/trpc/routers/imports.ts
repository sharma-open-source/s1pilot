import { IdSchema, ProjectKeySchema, S1PilotError } from '@s1pilot/domain';
import { IMPORT_FORMATS, applyImport, csvHeaders, detectImportFormat, parseImport, type ImportFormat } from '@s1pilot/sync';
import { z } from 'zod';

import { publicProcedure, router } from '../trpc.js';

import { requireProject, requireSuiteIn } from './helpers.js';

/** Largest accepted import file (characters). */
const MAX_CONTENT = 5_000_000;

const FileInput = z.object({
  filename: z.string().max(260).default('import.txt'),
  content: z.string().min(1, 'The file is empty').max(MAX_CONTENT, 'The file is too large (5 MB max)'),
});

const MappingSchema = z
  .object({
    title: z.string(),
    id: z.string(),
    suite: z.string(),
    priority: z.string(),
    tags: z.string(),
    steps: z.string(),
    expected: z.string(),
    data: z.string(),
  })
  .partial();

const SourceInput = FileInput.extend({
  format: z.enum(IMPORT_FORMATS as [ImportFormat, ...ImportFormat[]]).optional(),
  mapping: MappingSchema.optional(),
});

function resolveFormat(input: z.infer<typeof SourceInput>): ImportFormat {
  const format = input.format ?? detectImportFormat(input.filename, input.content);
  if (!format) throw new S1PilotError('IMPORT_INVALID', `Cannot detect the format of ${input.filename}`, { filename: input.filename });
  return format;
}

/** Test case importers (S-062): detect, preview the mapping, import idempotently by external ref. */
export const importsRouter = router({
  /** Detects the format of an uploaded file. */
  detect: publicProcedure.input(FileInput).mutation(({ input }) => ({
    format: detectImportFormat(input.filename, input.content) ?? null,
  })),

  /**
   * Parses the file without writing anything: format, CSV headers and guessed mapping, the first 10 cases,
   * totals and per-item errors.
   */
  preview: publicProcedure.input(SourceInput.extend({ projectKey: ProjectKeySchema })).mutation(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const format = resolveFormat(input);
    const csv = format === 'csv' ? csvHeaders(input.content) : undefined;
    const parsed = parseImport(format, input.content, { filename: input.filename, ...(input.mapping ? { mapping: input.mapping } : {}) });
    let existing = 0;
    for (const c of parsed.cases) {
      if (await ctx.repos.cases.getByExternalRef(ctx.db, project.id, c.externalRef)) existing++;
    }
    return {
      format,
      headers: csv?.headers ?? [],
      mapping: csv ? { ...csv.mapping, ...input.mapping } : null,
      total: parsed.cases.length,
      willCreate: parsed.cases.length - existing,
      willUpdate: existing,
      sample: parsed.cases.slice(0, 10).map((c) => ({
        externalRef: c.externalRef,
        title: c.title,
        suitePath: c.suitePath,
        priority: c.priority,
        tags: c.tags,
        stepCount: c.steps.length,
        parameterRows: c.parameters.length,
      })),
      errors: parsed.errors,
    };
  }),

  /** Imports the file as draft cases under `suiteId` (or the top level) and returns the report. */
  run: publicProcedure.input(SourceInput.extend({ projectKey: ProjectKeySchema, suiteId: IdSchema.optional() })).mutation(async ({ ctx, input }) => {
    if (ctx.user.role === 'viewer') throw new S1PilotError('FORBIDDEN', 'Viewers cannot import test cases');
    const project = await requireProject(ctx, input.projectKey);
    if (input.suiteId !== undefined) await requireSuiteIn(ctx, input.suiteId, project.id);
    const format = resolveFormat(input);
    const parsed = parseImport(format, input.content, { filename: input.filename, ...(input.mapping ? { mapping: input.mapping } : {}) });
    const report = await applyImport(ctx.db, project.id, parsed.cases, input.suiteId !== undefined ? { targetSuiteId: input.suiteId } : {});
    return {
      format,
      created: report.created,
      updated: report.updated,
      skipped: report.skipped,
      errors: [...parsed.errors, ...report.errors],
      keys: report.keys,
    };
  }),
});
