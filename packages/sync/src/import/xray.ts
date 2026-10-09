import {
  importError,
  mapPriority,
  splitPath,
  type ImportedCase,
  type ImportedStep,
  type ImportIssue,
  type ParseResult,
} from './types.js';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const nameOf = (v: unknown): string => (isObj(v) ? str(v.name) || str(v.value) : str(v));

/**
 * Imports an Xray JSON export: an array of tests (or `{tests}` / `{issues}`), each with `key`, `fields`
 * (`summary`, `priority`, `labels`), a folder path and `steps` (`action`, `data`, `result`).
 */
export function parseXray(text: string): ParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    importError(`Invalid JSON: ${(e as Error).message}`);
  }
  const list = Array.isArray(doc) ? doc : isObj(doc) ? (doc.tests ?? doc.issues ?? doc.testCases) : undefined;
  if (!Array.isArray(list)) importError('Xray export must be an array of tests or an object with `tests` / `issues`');

  const cases: ImportedCase[] = [];
  const errors: ImportIssue[] = [];
  list.forEach((raw: unknown, i) => {
    const index = i + 1;
    if (!isObj(raw)) {
      errors.push({ index, message: 'Entry is not an object' });
      return;
    }
    const fields = isObj(raw.fields) ? raw.fields : raw;
    const title = str(fields.summary) || str(fields.title) || str(fields.name);
    const key = str(raw.key) || str(raw.id) || str(raw.issueKey);
    if (!title) {
      errors.push({ index, message: 'Test has no summary' });
      return;
    }
    const rawSteps = [fields.steps, raw.steps, fields.manualTestSteps, raw.manualTestSteps].find(Array.isArray) as unknown[] | undefined;
    const steps: ImportedStep[] = [];
    for (const s of rawSteps ?? []) {
      if (!isObj(s)) continue;
      const fieldsOf = isObj(s.fields) ? s.fields : s;
      const action = str(fieldsOf.action) || str(fieldsOf.step);
      if (!action) continue;
      const data = str(fieldsOf.data);
      const result = str(fieldsOf.result) || str(fieldsOf.expectedResult);
      steps.push({ action: data ? `${action} (data: ${data})` : action, ...(result ? { expected: result } : {}) });
    }
    const gherkin = str(fields.gherkin) || str(raw.gherkin) || str(fields.definition);
    if (steps.length === 0 && gherkin) {
      for (const line of gherkin.split(/\r?\n/)) {
        const m = /^\s*(?:Given|When|Then|And|But)\s+(.*)$/.exec(line);
        if (m) steps.push({ action: m[1] as string });
      }
    }
    if (steps.length === 0) {
      errors.push({ index, title, message: 'Test has no steps' });
      return;
    }
    const folder = str(raw.folder) || str(raw.folderPath) || str(raw.testRepositoryPath) || str(fields.folder);
    const labels = Array.isArray(fields.labels) ? fields.labels.map(str).filter(Boolean) : [];
    cases.push({
      externalRef: `xray:${key || title}`,
      title,
      suitePath: splitPath(folder),
      priority: mapPriority(nameOf(fields.priority)),
      tags: labels,
      steps,
      parameters: [],
    });
  });
  return { cases, errors };
}
