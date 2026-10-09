import { guessCsvMapping, parseCsvCases, parseCsvRows } from './csv.js';
import { importError, type ParseResult } from './types.js';

/**
 * Imports a Zephyr (Scale) CSV export: `Key`/`Name`/`Folder`/`Priority`/`Labels` plus one row per step in the
 * `Test Script (Step-by-Step)` columns. Folders become suites.
 */
export function parseZephyr(text: string): ParseResult {
  const [header] = parseCsvRows(text);
  if (!header) importError('CSV is empty');
  const mapping = guessCsvMapping(header.map((h) => h.trim()));
  const r = parseCsvCases(text, mapping);
  return { ...r, cases: r.cases.map((c) => ({ ...c, externalRef: c.externalRef.replace(/^csv:/, 'zephyr:') })) };
}
