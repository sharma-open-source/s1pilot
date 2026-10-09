import { csvHeaders, parseCsvCases, type CsvMapping } from './csv.js';
import { parseGherkin } from './gherkin.js';
import { parsePlaywrightSpec } from './playwright-spec.js';
import { parseTestRail } from './testrail.js';
import { importError, type ImportFormat, type ParseResult } from './types.js';
import { parseXray } from './xray.js';
import { parseZephyr } from './zephyr.js';

export * from './apply.js';
export * from './csv.js';
export * from './gherkin.js';
export * from './playwright-spec.js';
export * from './testrail.js';
export * from './types.js';
export * from './xray.js';
export * from './zephyr.js';

/**
 * Detects the import format from the file name and a content sniff. Returns `undefined` when the file
 * is not recognisable.
 */
export function detectImportFormat(filename: string, content: string): ImportFormat | undefined {
  const name = filename.toLowerCase();
  const head = content.trimStart().slice(0, 2000);
  if (name.endsWith('.feature') || /^(#.*\n|@.*\n|\s)*Feature:/m.test(head)) return 'gherkin';
  if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(name) || (/\.[cm]?[jt]sx?$/.test(name) && /\btest(\.describe)?\(/.test(content))) return 'playwright';
  if (name.endsWith('.xml') || head.startsWith('<')) return head.includes('<case') || head.includes('<section') || head.includes('<suite') ? 'testrail' : undefined;
  if (name.endsWith('.json') || head.startsWith('{') || head.startsWith('[')) return 'xray';
  if (name.endsWith('.csv') || content.includes(',')) {
    try {
      const { headers } = csvHeaders(content);
      const h = headers.map((x) => x.toLowerCase());
      if (h.some((x) => x.startsWith('test script (step-by-step)') || x === 'objective')) return 'zephyr';
      if (h.includes('section hierarchy') || (h.includes('section') && h.includes('expected result'))) return 'testrail';
      return 'csv';
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface ParseImportOptions {
  filename?: string;
  /** CSV column mapping overrides (format `csv` only). */
  mapping?: Partial<CsvMapping>;
}

/** Parses `content` with the importer for `format`. Throws `IMPORT_INVALID` for unreadable sources. */
export function parseImport(format: ImportFormat, content: string, opts: ParseImportOptions = {}): ParseResult {
  const source = opts.filename?.split(/[\\/]/).pop();
  switch (format) {
    case 'csv':
      return parseCsvCases(content, opts.mapping);
    case 'gherkin':
      return parseGherkin(content, source ? { source } : {});
    case 'testrail':
      return parseTestRail(content);
    case 'xray':
      return parseXray(content);
    case 'zephyr':
      return parseZephyr(content);
    case 'playwright':
      return parsePlaywrightSpec(content, source ? { source } : {});
    default:
      return importError(`Unknown import format: ${String(format)}`);
  }
}
