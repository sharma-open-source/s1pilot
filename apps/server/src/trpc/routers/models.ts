import {
  AdapterKindSchema,
  ModelSettingsSchema,
  ProbeResultSchema,
  ProjectKeySchema,
  type ModelEndpoint,
  type ModelSettings,
  type ProbeResult,
} from '@s1pilot/domain';
import { probe } from '@s1pilot/providers';
import { z } from 'zod';

import { modelKeys } from '../../worker/models.js';
import type { Context } from '../context.js';
import { publicProcedure, router } from '../trpc.js';

import { WORKSPACE_MODEL_KEY, getWorkspaceModelSettings, requireProject } from './helpers.js';

const Target = z.union([z.literal('workspace'), ProjectKeySchema]);

/** Resolves an `env:NAME` key reference for probing; other refs (`secret:`) are resolved by the runner. */
function resolveKey(ref: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return ref?.startsWith('env:') ? env[ref.slice(4)] : undefined;
}

async function readSettings(ctx: Context, target: string) {
  const workspace = (await getWorkspaceModelSettings(ctx)) ?? null;
  if (target === 'workspace') {
    return { scope: 'workspace' as const, settings: workspace, effective: workspace, inheritsFromWorkspace: false };
  }
  const own = (await requireProject(ctx, target)).modelSettings ?? null;
  return {
    scope: 'project' as const,
    settings: own,
    effective: own ?? workspace,
    inheritsFromWorkspace: own === null,
  };
}

const STATUS_TTL_MS = 30_000;
export interface EndpointStatus {
  configured: boolean;
  reachable: boolean;
  model?: string;
  latencyMs?: number;
  error?: string;
}
const statusCache = new WeakMap<object, Map<string, { at: number; value: EndpointStatus }>>();

/** Keys the runs would use for `settings` (see {@link modelKeys}); a missing referenced variable becomes an error text. */
function statusKeys(settings: ModelSettings | null | undefined): { s1?: string; s2?: string; error?: string } {
  if (!settings) return {};
  try {
    return modelKeys(settings);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function endpointStatus(ctx: Context, ep: ModelEndpoint | undefined, apiKey: string | undefined, keyError?: string): Promise<EndpointStatus> {
  if (!ep) return { configured: false, reachable: false };
  if (ep.adapter === 'mock' || ep.baseUrl === undefined) return { configured: true, reachable: true, model: ep.model };
  if (keyError !== undefined) return { configured: true, reachable: false, model: ep.model, error: keyError };
  let cache = statusCache.get(ctx.db);
  if (!cache) statusCache.set(ctx.db, (cache = new Map()));
  const cacheKey = `${ep.adapter}|${ep.baseUrl}|${ep.model}|${apiKey === undefined ? 'nokey' : 'key'}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
  const r = await probe(
    { baseUrl: ep.baseUrl, model: ep.model, adapter: ep.adapter, ...(apiKey ? { apiKey } : {}) },
    { timeoutMs: 3000, samples: 1 },
  );
  const value: EndpointStatus = {
    configured: true,
    reachable: r.ok,
    model: ep.model,
    ...(r.ok ? { latencyMs: r.latencyMs.p50 } : r.error !== undefined ? { error: r.error } : {}),
  };
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** Workspace/project model settings, connection probe and reachability status. */
export const modelsRouter = router({
  /** `'workspace'` or a project key. Project settings fall back to the workspace defaults (`effective`). */
  getSettings: publicProcedure.input(Target).query(({ ctx, input }) => readSettings(ctx, input)),

  /** Saves settings for the target; `settings: null` removes a project override / the workspace default. */
  updateSettings: publicProcedure
    .input(z.object({ target: Target, settings: ModelSettingsSchema.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const { db, repos } = ctx;
      if (input.target === 'workspace') {
        if (input.settings) await repos.settings.set(db, WORKSPACE_MODEL_KEY, input.settings);
        else await repos.settings.delete(db, WORKSPACE_MODEL_KEY);
      } else {
        const project = await requireProject(ctx, input.target);
        if (input.settings === null) {
          // The repo merges patches and cannot clear the override, so null the column directly.
          db.sqlite.prepare('UPDATE projects SET model_settings = NULL, updated_at = ? WHERE id = ?').run(
            new Date().toISOString(),
            project.id,
          );
        } else {
          await repos.projects.update(db, project.id, { modelSettings: input.settings });
        }
      }
      return readSettings(ctx, input.target);
    }),

  /** "Test connection": probes an endpoint. The key is used for this call only and never stored. */
  probe: publicProcedure
    .input(
      z.object({
        baseUrl: z.string().url(),
        model: z.string().min(1).optional(),
        adapter: z.union([AdapterKindSchema, z.literal('auto')]).default('auto'),
        apiKey: z.string().min(1).optional(),
        apiKeyRef: z.string().optional(),
        timeoutMs: z.number().int().min(100).max(60_000).default(5000),
      }),
    )
    .mutation(async ({ input }): Promise<ProbeResult> => {
      const apiKey = input.apiKey ?? resolveKey(input.apiKeyRef);
      const result = await probe(
        {
          baseUrl: input.baseUrl,
          adapter: input.adapter,
          ...(input.model ? { model: input.model } : {}),
          ...(apiKey ? { apiKey } : {}),
        },
        { timeoutMs: input.timeoutMs },
      );
      return ProbeResultSchema.parse(result);
    }),

  /** Reachability of System 1 / System 2 for the nav footer. Cached for 30 s per endpoint. */
  status: publicProcedure
    .input(z.object({ projectKey: ProjectKeySchema.optional() }).optional())
    .query(async ({ ctx, input }) => {
      const { effective } = await readSettings(ctx, input?.projectKey ?? 'workspace');
      // Same keys as the runs use, so "reachable" means a run (or test generation) will authenticate.
      const keys = statusKeys(effective);
      const [system1, system2] = await Promise.all([
        endpointStatus(ctx, effective?.system1, keys.s1, keys.error),
        endpointStatus(ctx, effective?.system2, keys.s2, keys.error),
      ]);
      return { system1, system2 };
    }),
});
