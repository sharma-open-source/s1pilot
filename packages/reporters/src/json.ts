import { RunReportSchema, type RunReport } from '@s1pilot/domain';

/** Validates a report against `RunReportSchema`; throws a `ZodError` when it does not conform. */
export function parseRunReport(report: unknown): RunReport {
  return RunReportSchema.parse(report);
}

/** Renders the full run report (cases, step results, decisions) as schema-validated, pretty JSON. */
export function renderJson(report: RunReport): string {
  return `${JSON.stringify(parseRunReport(report), null, 2)}\n`;
}
