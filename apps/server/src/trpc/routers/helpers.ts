import {
  ModelSettingsSchema,
  S1PilotError,
  type Environment,
  type ModelSettings,
  type Project,
  type Suite,
  type TestCase,
} from '@s1pilot/domain';

import type { Context } from '../context.js';

/** Settings key holding the workspace-level model defaults. */
export const WORKSPACE_MODEL_KEY = 'workspace.modelSettings';

/** Loads a project by key or throws `PROJECT_NOT_FOUND`. */
export async function requireProject(ctx: Context, key: string): Promise<Project> {
  const project = await ctx.repos.projects.getByKey(ctx.db, key);
  if (!project) throw new S1PilotError('PROJECT_NOT_FOUND', `Project not found: ${key}`, { key });
  return project;
}

/** Loads a case by human key (`SHOP-TC-42`) or throws `CASE_NOT_FOUND`. */
export async function requireCase(ctx: Context, key: string): Promise<TestCase> {
  const c = await ctx.repos.cases.getByKey(ctx.db, key);
  if (!c) throw new S1PilotError('CASE_NOT_FOUND', `Case not found: ${key}`, { key });
  return c;
}

/** Loads a suite by id or throws `SUITE_NOT_FOUND`. */
export async function requireSuite(ctx: Context, id: string): Promise<Suite> {
  const s = await ctx.repos.suites.get(ctx.db, id);
  if (!s) throw new S1PilotError('SUITE_NOT_FOUND', `Suite not found: ${id}`, { id });
  return s;
}

/** Throws `SUITE_NOT_FOUND` unless the suite exists and belongs to `projectId`. */
export async function requireSuiteIn(ctx: Context, id: string, projectId: string): Promise<Suite> {
  const s = await requireSuite(ctx, id);
  if (s.projectId !== projectId) throw new S1PilotError('SUITE_NOT_FOUND', `Suite not found in project: ${id}`, { id });
  return s;
}

/** Loads an environment by id or throws `ENVIRONMENT_NOT_FOUND`. */
export async function requireEnvironment(ctx: Context, id: string): Promise<Environment> {
  const env = await ctx.repos.environments.get(ctx.db, id);
  if (!env) throw new S1PilotError('ENVIRONMENT_NOT_FOUND', `Environment not found: ${id}`, { id });
  return env;
}

/** Workspace default model settings, or `undefined` when none were saved (or the stored value is invalid). */
export async function getWorkspaceModelSettings(ctx: Context): Promise<ModelSettings | undefined> {
  const raw = await ctx.repos.settings.get(ctx.db, WORKSPACE_MODEL_KEY);
  const parsed = ModelSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Project override if present, else the workspace default. */
export async function effectiveModelSettings(ctx: Context, project: Project): Promise<ModelSettings | undefined> {
  return project.modelSettings ?? (await getWorkspaceModelSettings(ctx));
}

/** Environment as returned to clients: secret variables carry only `{ masked: true }`, never a value. */
export function maskEnvironment(env: Environment) {
  return {
    ...env,
    variables: env.variables.map((v) =>
      v.secret
        ? { key: v.key, secret: true as const, masked: true as const, source: v.source, envVar: v.envVar }
        : { key: v.key, secret: false as const, value: v.value, source: v.source, envVar: v.envVar },
    ),
  };
}
export type MaskedEnvironment = ReturnType<typeof maskEnvironment>;
