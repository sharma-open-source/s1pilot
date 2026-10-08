import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
  DataPolicySchema,
  EnvironmentSchema,
  ModelEndpointSchema,
  ProjectKeySchema,
  S1PilotError,
  TestCaseFileSchema,
  TestCaseSchema,
  ThresholdsSchema,
  newId,
  type Environment,
  type Project,
  type TestCase,
} from '@s1pilot/domain';
import { parse } from 'yaml';
import { z } from 'zod';

import { normalizeFlowSteps } from './flows.js';

/** Directory (inside a project root) holding the tests-as-code files. */
export const PROJECT_DIR = '.s1pilot';
/** Project file name inside {@link PROJECT_DIR}. */
export const PROJECT_FILE = 'project.yaml';

function parseYamlFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new S1PilotError('FILE_UNREADABLE', `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, { path });
  }
  try {
    return parse(raw) as unknown;
  } catch (error) {
    throw new S1PilotError('YAML_INVALID', `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`, { path });
  }
}

function invalid(code: string, path: string, error: z.ZodError): S1PilotError {
  const issues = error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
  const text = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
  return new S1PilotError(code, `${path} is invalid:\n${text}`, { path, issues });
}

/** Options for {@link loadCaseFile}. */
export interface LoadCaseOptions {
  /** Project the case belongs to; a fresh id when omitted. */
  projectId?: string;
  suiteId?: string;
}

/**
 * Loads one YAML test case (plan 1.2 format) and validates it with `TestCaseFileSchema`.
 * Throws `S1PilotError` (`FILE_UNREADABLE`, `YAML_INVALID`, `CASE_FILE_INVALID`) with the file path
 * and every validation issue.
 */
export function loadCaseFile(path: string, opts: LoadCaseOptions = {}): TestCase {
  const file = resolve(path);
  const doc = parseYamlFile(file);
  const withFlows =
    typeof doc === 'object' && doc !== null && !Array.isArray(doc)
      ? { ...doc, steps: normalizeFlowSteps((doc as { steps?: unknown }).steps) }
      : doc;
  const parsed = TestCaseFileSchema.safeParse(withFlows);
  if (!parsed.success) throw invalid('CASE_FILE_INVALID', file, parsed.error);
  return TestCaseSchema.parse({
    id: newId(),
    projectId: opts.projectId ?? newId(),
    ...(opts.suiteId ? { suiteId: opts.suiteId } : {}),
    version: 1,
    ...parsed.data,
  });
}

/** Variable as written in YAML; `value: env:NAME` is shorthand for a variable read from the process environment. */
const VariableFileSchema = z
  .object({
    key: z.string().min(1),
    value: z.string().optional(),
    secret: z.boolean().default(false),
    source: z.enum(['inline', 'env']).optional(),
    envVar: z.string().optional(),
  })
  .transform((v) => {
    if (v.source === undefined && v.value?.startsWith('env:')) {
      const { value: ref, ...rest } = v;
      return { ...rest, source: 'env' as const, envVar: ref.slice('env:'.length) };
    }
    return { ...v, source: v.source ?? ('inline' as const) };
  });

const EnvironmentFileSchema = EnvironmentSchema.omit({ id: true, projectId: true, variables: true, readOnly: true }).extend({
  variables: z.array(VariableFileSchema).default([]),
  /** Defaults to true for environments named `production` / `prod`. */
  readOnly: z.boolean().optional(),
});

/** `model:` block of `project.yaml`; secrets by `env:NAME` reference only. */
export const ProjectModelFileSchema = z.object({
  system1: ModelEndpointSchema,
  system2: ModelEndpointSchema.optional(),
  /** Falls back to the System 1 profile's thresholds. */
  thresholds: ThresholdsSchema.optional(),
  dualOrderSensitive: z.boolean().default(false),
});
export type ProjectModelFile = z.infer<typeof ProjectModelFileSchema>;

/** YAML shape of `.s1pilot/project.yaml`. */
export const ProjectFileSchema = z.object({
  key: ProjectKeySchema,
  name: z.string().min(1),
  defaultEnvironment: z.string().optional(),
  retentionDays: z.number().int().positive().default(30),
  dataPolicy: DataPolicySchema.default({}),
  environments: z.array(EnvironmentFileSchema).default([]),
  model: ProjectModelFileSchema.optional(),
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

/** A project directory read from disk. */
export interface LoadedProject {
  /** Directory that contains `.s1pilot/`. */
  root: string;
  project: Project;
  environments: Environment[];
  /** Model settings from the file; thresholds may still be missing. */
  model?: ProjectModelFile;
  cases: TestCase[];
}

/** Lists `*.yaml` / `*.yml` files below `dir`, sorted, skipping `node_modules` and dot-directories. */
export function listYamlFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(full);
      } else if (/\.ya?ml$/i.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(resolve(dir));
  return out;
}

/** Walks up from `start` to the nearest directory containing `.s1pilot/project.yaml`. */
export function findProjectRoot(start: string): string | undefined {
  let dir = resolve(start);
  try {
    if (statSync(dir).isFile()) dir = dirname(dir);
  } catch {
    return undefined;
  }
  for (;;) {
    try {
      if (statSync(join(dir, PROJECT_DIR, PROJECT_FILE)).isFile()) return dir;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Reads only `.s1pilot/project.yaml` (project, environments, model settings). */
export function loadProjectFile(root: string): Omit<LoadedProject, 'cases'> {
  const file = join(resolve(root), PROJECT_DIR, PROJECT_FILE);
  const parsed = ProjectFileSchema.safeParse(parseYamlFile(file));
  if (!parsed.success) throw invalid('PROJECT_FILE_INVALID', file, parsed.error);
  const data = parsed.data;
  const projectId = newId();
  const environments = data.environments.map((e) =>
    EnvironmentSchema.parse({
      ...e,
      id: newId(),
      projectId,
      readOnly: e.readOnly ?? /^prod(uction)?$/i.test(e.name),
    }),
  );
  if (data.defaultEnvironment && !environments.some((e) => e.name === data.defaultEnvironment)) {
    throw new S1PilotError('PROJECT_FILE_INVALID', `${file}: defaultEnvironment "${data.defaultEnvironment}" is not defined`, { path: file });
  }
  const defaultEnvironmentId = environments.find((e) => e.name === data.defaultEnvironment)?.id;
  const project: Project = {
    id: projectId,
    name: data.name,
    key: data.key,
    ...(defaultEnvironmentId ? { defaultEnvironmentId } : {}),
    ...(data.model?.thresholds ? { modelSettings: { ...data.model, thresholds: data.model.thresholds } } : {}),
    retentionDays: data.retentionDays,
    dataPolicy: data.dataPolicy,
  };
  return { root: resolve(root), project, environments, ...(data.model ? { model: data.model } : {}) };
}

/**
 * Loads a project directory: `.s1pilot/project.yaml` plus every case under `.s1pilot/suites/**`.
 * Secrets are never read here: variables stay `env:` references.
 */
export function loadProjectDir(dir: string): LoadedProject {
  const base = loadProjectFile(dir);
  const suites = join(base.root, PROJECT_DIR, 'suites');
  let files: string[] = [];
  try {
    files = listYamlFiles(suites);
  } catch {
    // no suites directory yet
  }
  const cases = files.map((f) => loadCaseFile(f, { projectId: base.project.id }));
  return { ...base, cases };
}

/** Case file name without extension, used for output folder names. */
export function caseFileStem(path: string): string {
  return basename(path).replace(/\.ya?ml$/i, '');
}
