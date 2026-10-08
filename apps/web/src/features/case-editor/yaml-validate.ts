import { parseDocument } from 'yaml';

import type { YamlMarker } from './YamlEditor';

/** Syntax check for the YAML tab: reports parse errors with line/column and requires a mapping with `steps`. */
export function validateYaml(text: string): YamlMarker[] {
  const doc = parseDocument(text, { prettyErrors: true });
  const markers: YamlMarker[] = doc.errors.map((e) => ({
    line: e.linePos?.[0].line ?? 1,
    column: e.linePos?.[0].col ?? 1,
    message: e.message.split('\n')[0] ?? e.message,
  }));
  if (markers.length > 0) return markers;
  const value: unknown = doc.toJS();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ line: 1, column: 1, message: 'The case must be a YAML mapping (key, title, steps, ...)' }];
  }
  if (!Array.isArray((value as Record<string, unknown>)['steps'])) {
    return [{ line: 1, column: 1, message: 'Missing "steps" list' }];
  }
  return [];
}
