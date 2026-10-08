import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';

import { S1PilotError, StepSchema, type SharedStep } from '@s1pilot/domain';
import { parse } from 'yaml';
import { z } from 'zod';

/** Directory (inside `.s1pilot/`) holding shared flows, `<name>.yaml`. */
export const FLOWS_DIR = 'flows';
/** Directory (inside `.s1pilot/`) holding test data sets, `<name>.csv|json`. */
export const DATA_DIR = 'data';

type Raw = Record<string, unknown>;

/**
 * Rewrites YAML `- flow: <name>` (+ optional `args:`) steps into shared-step reference steps
 * (`sharedStepId` + `args`) that the engine inlines. Other steps pass through unchanged.
 */
export function normalizeFlowSteps(rawSteps: unknown): unknown {
  if (!Array.isArray(rawSteps)) return rawSteps;
  return rawSteps.map((s: unknown) => {
    if (typeof s !== 'object' || s === null || Array.isArray(s) || typeof (s as Raw)['flow'] !== 'string') return s;
    const { flow, args, ...rest } = s as Raw;
    return { ...rest, action: `Run flow ${String(flow)}`, sharedStepId: flow, ...(args !== undefined ? { args } : {}) };
  });
}

const FlowFileSchema = z.object({
  name: z.string().min(1).optional(),
  params: z.array(z.string()).default([]),
  steps: z.array(StepSchema).min(1, 'a flow needs at least one step'),
});

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new S1PilotError('FILE_UNREADABLE', `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, { path });
  }
}

/** Safe single path segment for flow / data set names (no traversal). */
function checkName(kind: string, name: string): void {
  if (name.length === 0 || name.includes('..') || name.includes('/') || name.includes('\\') || name.includes(sep)) {
    throw new S1PilotError('NAME_INVALID', `Invalid ${kind} name "${name}"`, { name });
  }
}

/**
 * Loads `.s1pilot/flows/<name>.yaml` as a shared step (`id` = `name`). Throws `FLOW_NOT_FOUND` when
 * missing and `FLOW_FILE_INVALID` when the file does not validate.
 */
export function loadFlow(root: string, name: string, projectId = 'local'): SharedStep {
  checkName('flow', name);
  const dir = join(resolve(root), '.s1pilot', FLOWS_DIR);
  const file = [join(dir, `${name}.yaml`), join(dir, `${name}.yml`)].find((f) => existsSync(f));
  if (!file) throw new S1PilotError('FLOW_NOT_FOUND', `Flow "${name}" not found (expected ${join(dir, `${name}.yaml`)})`, { flow: name });
  let doc: unknown;
  try {
    doc = parse(readText(file));
  } catch (error) {
    throw new S1PilotError('YAML_INVALID', `${file} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`, { path: file });
  }
  const raw = typeof doc === 'object' && doc !== null ? (doc as Raw) : {};
  const parsed = FlowFileSchema.safeParse({ ...raw, steps: normalizeFlowSteps(raw['steps']) });
  if (!parsed.success) {
    const text = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new S1PilotError('FLOW_FILE_INVALID', `${file} is invalid:\n${text}`, { path: file });
  }
  return { id: name, projectId, name, params: parsed.data.params, steps: parsed.data.steps };
}

/** Lookup suitable for the engine's `FlowLookup`: loads (and caches) flows on demand; unknown flows give `undefined`. */
export function flowLookup(root: string, projectId?: string): (idOrName: string) => SharedStep | undefined {
  const cache = new Map<string, SharedStep | undefined>();
  return (name) => {
    if (!cache.has(name)) {
      try {
        cache.set(name, loadFlow(root, name, projectId));
      } catch (error) {
        if (error instanceof S1PilotError && (error.code === 'FLOW_NOT_FOUND' || error.code === 'NAME_INVALID')) cache.set(name, undefined);
        else throw error;
      }
    }
    return cache.get(name);
  };
}

/** Parses CSV text (RFC 4180: quoted fields, `""` escapes, CRLF) into rows keyed by the header line. */
export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.startsWith(String.fromCharCode(0xfeff)) ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      records.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  const rows = records.filter((r) => r.some((f) => f.trim() !== ''));
  const header = rows.shift()?.map((h) => h.trim()) ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const DatasetRowSchema = z.record(z.union([z.string(), z.number(), z.boolean()]));

/**
 * Loads a test data set from `.s1pilot/data/[<environment>/]<name>` (`.csv` or `.json`; the
 * extension may be omitted). An environment-specific file wins over the shared one. Returns
 * `undefined` when no such data set exists. JSON must be an array of flat objects.
 */
export function loadDataset(root: string, name: string, environment?: string): Record<string, string | number | boolean>[] | undefined {
  checkName('data set', name);
  const base = join(resolve(root), '.s1pilot', DATA_DIR);
  const dirs = [...(environment ? [join(base, environment)] : []), base];
  const names = /\.(csv|json)$/i.test(name) ? [name] : [`${name}.csv`, `${name}.json`];
  for (const dir of dirs) {
    if (environment) checkName('environment', environment);
    for (const candidate of names) {
      const file = join(dir, candidate);
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      if (/\.csv$/i.test(candidate)) return parseCsv(readText(file));
      let doc: unknown;
      try {
        doc = JSON.parse(readText(file));
      } catch (error) {
        throw new S1PilotError('DATASET_INVALID', `${basename(file)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { path: file });
      }
      const parsed = z.array(DatasetRowSchema).safeParse(doc);
      if (!parsed.success) throw new S1PilotError('DATASET_INVALID', `${file} must be an array of flat objects`, { path: file });
      return parsed.data;
    }
  }
  return undefined;
}
