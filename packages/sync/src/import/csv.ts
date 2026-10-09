import { createHash } from 'node:crypto';

import {
  importError,
  mapPriority,
  splitNumberedLines,
  splitPath,
  splitTags,
  type ImportedCase,
  type ImportedStep,
  type ImportIssue,
  type ParseResult,
} from './types.js';

/** Parses RFC 4180 CSV (quoted fields, embedded newlines, `""` escapes, CRLF) into rows. */
export function parseCsvRows(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) importError('CSV has an unterminated quoted field');
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** Column names (header text) each case field is read from; absent fields are ignored. */
export interface CsvMapping {
  title: string;
  id?: string;
  suite?: string;
  priority?: string;
  tags?: string;
  /** Step action column (numbered lines in one cell, or one step per row). */
  steps?: string;
  /** Expected-result column, aligned with `steps`. */
  expected?: string;
  /** Test-data column appended to the step text. */
  data?: string;
}

const GUESS: Record<keyof CsvMapping, RegExp> = {
  title: /^(title|name|summary|test case( name| title)?|scenario)$/i,
  id: /^(id|key|test case (id|key)|case id|external id|issue key)$/i,
  suite: /^(suite|section( hierarchy)?|folder|module|component|path)$/i,
  priority: /^(priority)$/i,
  tags: /^(tags?|labels?)$/i,
  steps: /^(steps?|test steps?|step action|action|test script \(step-by-step\) - step|steps \(.*\))$/i,
  expected: /^(expected( result| results| outcome)?|step expected result|result|test script \(step-by-step\) - expected result)$/i,
  data: /^(data|test data|step data|test script \(step-by-step\) - test data)$/i,
};

/** Guesses a mapping from header names; `title` is missing (empty string) when nothing fits. */
export function guessCsvMapping(headers: string[]): CsvMapping {
  const pick = (key: keyof CsvMapping): string | undefined => headers.find((h) => GUESS[key].test(h.trim()));
  const mapping: CsvMapping = { title: pick('title') ?? '' };
  for (const key of ['id', 'suite', 'priority', 'tags', 'steps', 'expected', 'data'] as const) {
    const h = pick(key);
    if (h !== undefined) mapping[key] = h;
  }
  return mapping;
}

/** Header row and guessed mapping of a CSV, for the wizard's mapping preview. */
export function csvHeaders(text: string): { headers: string[]; mapping: CsvMapping } {
  const [headers] = parseCsvRows(text);
  if (!headers) importError('CSV is empty');
  return { headers: headers.map((h) => h.trim()), mapping: guessCsvMapping(headers) };
}

/**
 * Imports test cases from CSV. Layouts: one row per case with steps as numbered lines in one cell, or one
 * row per step where continuation rows leave the title (and id) empty or repeat the id.
 */
export function parseCsvCases(text: string, mappingOverride?: Partial<CsvMapping>): ParseResult {
  const rows = parseCsvRows(text);
  const header = rows.shift();
  if (!header) importError('CSV is empty');
  const headers = header.map((h) => h.trim());
  const mapping: CsvMapping = { ...guessCsvMapping(headers), ...mappingOverride };
  const col = (name: string | undefined): number => (name === undefined ? -1 : headers.indexOf(name));
  if (col(mapping.title) < 0) importError(`CSV needs a title column; found: ${headers.join(', ')}`, { headers });
  const idx = {
    title: col(mapping.title),
    id: col(mapping.id),
    suite: col(mapping.suite),
    priority: col(mapping.priority),
    tags: col(mapping.tags),
    steps: col(mapping.steps),
    expected: col(mapping.expected),
    data: col(mapping.data),
  };
  const cell = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? '').trim() : '');
  const raw = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? '') : '');

  const cases: ImportedCase[] = [];
  const errors: ImportIssue[] = [];
  const byRef = new Map<string, ImportedCase>();
  let current: ImportedCase | undefined;
  let skipping = false;

  rows.forEach((r, n) => {
    const rowNo = n + 2;
    const title = cell(r, idx.title);
    const id = cell(r, idx.id);
    const addSteps = (target: ImportedCase): void => {
      const actions = splitNumberedLines(raw(r, idx.steps));
      const expected = splitNumberedLines(raw(r, idx.expected));
      const data = cell(r, idx.data);
      const numbered = actions.length > 1 || expected.length > 1;
      if (numbered) {
        actions.forEach((a, i) => target.steps.push(stepOf(a, expected[i], i === 0 ? data : '')));
        if (actions.length === 0 && expected.length > 0) target.steps.push(stepOf('Verify the result', expected.join('; ')));
      } else if (actions[0] !== undefined) target.steps.push(stepOf(actions[0], expected[0], data));
      else if (expected[0] !== undefined) {
        const last = target.steps[target.steps.length - 1];
        if (last && !last.expected) last.expected = expected[0];
        else target.steps.push(stepOf('Verify the result', expected[0]));
      }
    };

    if (title === '') {
      if (current) addSteps(current);
      else if (!skipping) errors.push({ index: rowNo, message: 'Row has no title and no previous case to continue' });
      return;
    }
    const suitePath = splitPath(cell(r, idx.suite));
    const externalRef = id !== '' ? `csv:${id}` : `csv:${hash([...suitePath, title].join('/'))}`;
    if (current && current.externalRef === externalRef) {
      addSteps(current);
      return;
    }
    if (byRef.has(externalRef)) {
      errors.push({ index: rowNo, title, message: `Duplicate id ${id || title}; first occurrence kept` });
      current = undefined;
      skipping = true;
      return;
    }
    skipping = false;
    const c: ImportedCase = {
      externalRef,
      title,
      suitePath,
      priority: mapPriority(cell(r, idx.priority)),
      tags: splitTags(cell(r, idx.tags)),
      steps: [],
      parameters: [],
    };
    addSteps(c);
    current = c;
    byRef.set(externalRef, c);
    cases.push(c);
  });

  for (const c of cases) {
    if (c.steps.length === 0) errors.push({ index: cases.indexOf(c) + 1, title: c.title, message: 'Case has no steps' });
  }
  return { cases: cases.filter((c) => c.steps.length > 0), errors };
}

function stepOf(action: string, expected: string | undefined, data = ''): ImportedStep {
  const text = data ? `${action} (data: ${data})` : action;
  return { action: text, ...(expected ? { expected } : {}) };
}

/** Short stable hash used to build external refs when the source has no id. */
export function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}
