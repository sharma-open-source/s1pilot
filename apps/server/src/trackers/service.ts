import { randomBytes, timingSafeEqual } from 'node:crypto';

import { S1PilotError, defectKey, type Defect, type DefectStatus } from '@s1pilot/domain';
import {
  createTracker,
  type ExternalStatus,
  type IssueTracker,
  type TrackerAttachment,
  type TrackerCredentials,
  type TrackerDefect,
  type TrackerMapping,
  type TrackerProvider,
} from '@s1pilot/integrations';
import { z } from 'zod';

import { createArtifactStore } from '../artifacts/factory.js';
import type { Context } from '../trpc/context.js';
import { applyUpdate } from '../trpc/routers/defects.js';

export const TRACKER_PROVIDERS = ['jira', 'github', 'linear'] as const;
export const TrackerProviderSchema = z.enum(TRACKER_PROVIDERS);

/** Workspace-level connection, stored in `settings` with credentials encrypted by the vault. */
const ConnectionRecordSchema = z.object({
  baseUrl: z.string().optional(),
  email: z.string().optional(),
  tokenCipher: z.string(),
  webhookCipher: z.string().optional(),
  updatedAt: z.string(),
});
type ConnectionRecord = z.infer<typeof ConnectionRecordSchema>;

/** Per-project mapping: which tracker and which Jira project / GitHub repo / Linear team. */
export const MappingRecordSchema = z.object({
  provider: TrackerProviderSchema,
  jiraProject: z.string().optional(),
  jiraIssueType: z.string().optional(),
  githubRepo: z.string().optional(),
  githubLabels: z.array(z.string()).optional(),
  linearTeamId: z.string().optional(),
});
export type MappingRecord = z.infer<typeof MappingRecordSchema>;

const connKey = (p: TrackerProvider): string => `tracker.connection:${p}`;
const mapKey = (projectId: string): string => `tracker.mapping:${projectId}`;

type Ctx = Pick<Context, 'db' | 'repos'>;

async function loadRecord(ctx: Ctx, provider: TrackerProvider): Promise<ConnectionRecord | undefined> {
  const raw = await ctx.repos.settings.get(ctx.db, connKey(provider));
  const parsed = ConnectionRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Public (secret-free) view of a connection. */
export async function connectionInfo(ctx: Ctx, provider: TrackerProvider) {
  const rec = await loadRecord(ctx, provider);
  return {
    provider,
    connected: rec !== undefined,
    baseUrl: rec?.baseUrl ?? null,
    email: rec?.email ?? null,
    webhookEnabled: rec?.webhookCipher !== undefined,
    updatedAt: rec?.updatedAt ?? null,
  };
}

/** Decrypted credentials. Server-side only; never return these from a procedure. */
export async function loadCredentials(ctx: Ctx, provider: TrackerProvider): Promise<TrackerCredentials | undefined> {
  const rec = await loadRecord(ctx, provider);
  if (!rec) return undefined;
  return { baseUrl: rec.baseUrl, email: rec.email, token: ctx.db.crypto.decrypt(rec.tokenCipher) };
}

/** Stores a connection; the token is encrypted. Keeps the existing webhook secret. */
export async function saveConnection(ctx: Ctx, provider: TrackerProvider, creds: TrackerCredentials): Promise<void> {
  const prev = await loadRecord(ctx, provider);
  const rec: ConnectionRecord = {
    ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
    ...(creds.email ? { email: creds.email } : {}),
    tokenCipher: ctx.db.crypto.encrypt(creds.token),
    ...(prev?.webhookCipher ? { webhookCipher: prev.webhookCipher } : {}),
    updatedAt: new Date().toISOString(),
  };
  await ctx.repos.settings.set(ctx.db, connKey(provider), rec);
}

export async function deleteConnection(ctx: Ctx, provider: TrackerProvider): Promise<void> {
  await ctx.repos.settings.delete(ctx.db, connKey(provider));
}

/** Generates a new inbound webhook secret and returns the path to configure at the tracker (shown once). */
export async function rotateWebhook(ctx: Ctx, provider: TrackerProvider): Promise<string> {
  const rec = await loadRecord(ctx, provider);
  if (!rec) throw new S1PilotError('TRACKER_NOT_CONNECTED', `${provider} is not connected`);
  const secret = randomBytes(24).toString('hex');
  await ctx.repos.settings.set(ctx.db, connKey(provider), { ...rec, webhookCipher: ctx.db.crypto.encrypt(secret) });
  return `/api/hooks/trackers/${provider}/${secret}`;
}

/** Constant-time check of an inbound webhook secret. */
export async function webhookMatches(ctx: Ctx, provider: TrackerProvider, given: string): Promise<boolean> {
  const rec = await loadRecord(ctx, provider);
  if (!rec?.webhookCipher) return false;
  const expected = Buffer.from(ctx.db.crypto.decrypt(rec.webhookCipher));
  const got = Buffer.from(given);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export async function getMapping(ctx: Ctx, projectId: string): Promise<MappingRecord | undefined> {
  const parsed = MappingRecordSchema.safeParse(await ctx.repos.settings.get(ctx.db, mapKey(projectId)));
  return parsed.success ? parsed.data : undefined;
}

export async function setMapping(ctx: Ctx, projectId: string, mapping: MappingRecord | null): Promise<void> {
  if (mapping === null) await ctx.repos.settings.delete(ctx.db, mapKey(projectId));
  else await ctx.repos.settings.set(ctx.db, mapKey(projectId), mapping);
}

/** Short label for the Defects eyebrow, e.g. `Jira project SHOP`. */
export function mappingLabel(m: MappingRecord): string {
  switch (m.provider) {
    case 'jira':
      return `Jira project ${m.jiraProject ?? ''}`.trim();
    case 'github':
      return `GitHub ${m.githubRepo ?? ''}`.trim();
    case 'linear':
      return `Linear team ${m.linearTeamId ?? ''}`.trim();
  }
}

/** Tracker target fields of a mapping. */
export function toTrackerMapping(m: MappingRecord | undefined): TrackerMapping {
  return m ? { jiraProject: m.jiraProject, jiraIssueType: m.jiraIssueType, githubRepo: m.githubRepo, githubLabels: m.githubLabels, linearTeamId: m.linearTeamId } : {};
}

/** Builds the tracker client for a provider from the stored connection. */
export async function trackerFor(ctx: Ctx, provider: TrackerProvider, mapping?: MappingRecord): Promise<IssueTracker> {
  const creds = await loadCredentials(ctx, provider);
  if (!creds) throw new S1PilotError('TRACKER_NOT_CONNECTED', `${provider} is not connected. Connect it in Settings > Integrations.`);
  return createTracker(provider, creds, toTrackerMapping(mapping));
}

function toTrackerDefect(d: Defect): TrackerDefect {
  return {
    key: defectKey(d),
    title: d.title,
    severity: d.severity,
    description: d.description,
    stepsToReproduce: d.details?.stepsToReproduce ?? [],
    expected: d.details?.expected ?? '',
    actual: d.details?.actual ?? '',
    environment: d.details?.environment,
    browser: d.details?.browser,
    buildRef: d.details?.buildRef,
    sourceLabel: d.details?.sourceLabel,
  };
}

const MAX_ATTACHMENTS = 3;

/** Screenshot evidence of a defect, read from the artifact store. Missing files are skipped. */
async function loadAttachments(ctx: Context, d: Defect): Promise<TrackerAttachment[]> {
  const store = createArtifactStore(ctx.db, ctx.config);
  const out: TrackerAttachment[] = [];
  for (const ev of (d.details?.evidence ?? []).filter((e) => e.kind === 'screenshot').slice(0, MAX_ATTACHMENTS)) {
    try {
      const meta = await store.stat(ev.artifactId);
      if (!meta) continue;
      const chunks: Buffer[] = [];
      for await (const chunk of await store.get(ev.artifactId)) chunks.push(Buffer.from(chunk as Buffer));
      out.push({ filename: meta.name, contentType: meta.contentType, data: new Uint8Array(Buffer.concat(chunks)) });
    } catch (error) {
      ctx.log.warn({ err: error instanceof Error ? error.message : 'unknown', artifactId: ev.artifactId }, 'tracker attachment skipped');
    }
  }
  return out;
}

/**
 * Pushes a defect to the tracker mapped for its project: creates the issue with title, repro steps,
 * expected / actual, environment and screenshot attachments, and stores the external reference.
 */
export async function pushDefect(ctx: Context, defectId: string): Promise<Defect> {
  const defect = await ctx.repos.defects.get(ctx.db, defectId);
  if (!defect) throw new S1PilotError('DEFECT_NOT_FOUND', `Defect not found: ${defectId}`, { id: defectId });
  if (defect.external) throw new S1PilotError('INVALID_STATE', `${defectKey(defect)} is already pushed to ${defect.external.provider}`);
  const mapping = await getMapping(ctx, defect.projectId);
  if (!mapping) throw new S1PilotError('TRACKER_NOT_MAPPED', 'No issue tracker is mapped for this project. Set one in Settings > Integrations.');
  const tracker = await trackerFor(ctx, mapping.provider, mapping);
  const issue = await tracker.createIssue(toTrackerDefect(defect), await loadAttachments(ctx, defect));
  const state = (await tracker.getStatus(issue.id).catch(() => undefined))?.state;
  const updated = await ctx.repos.defects.update(ctx.db, defect.id, {
    external: { provider: mapping.provider, id: issue.id, url: issue.url },
    ...(defect.status === 'draft' ? { status: 'open' as const } : {}),
    details: { ...(defect.details ?? {}), ...(state ? { trackerState: state } : {}) } as NonNullable<Defect['details']>,
  });
  ctx.log.info({ defect: defectKey(defect), provider: mapping.provider, issue: issue.id }, 'defect pushed to tracker');
  return updated;
}

export interface SyncOutcome {
  /** Local status after the sync (unchanged when `changed` is false). */
  status: DefectStatus;
  changed: boolean;
}

/**
 * Applies an external status to a defect. Only acts when the tracker's state differs from the last one seen,
 * so local edits are not overwritten on every poll. A move to fixed / closed queues the re-test (S-054).
 */
export async function applyExternalStatus(ctx: Context, defect: Defect, tracker: IssueTracker, ext: ExternalStatus): Promise<SyncOutcome> {
  if (!defect.external) return { status: defect.status, changed: false };
  if (defect.details?.trackerState === ext.state) return { status: defect.status, changed: false };
  const mapped = tracker.mapStatus(ext);
  const status = mapped !== defect.status ? mapped : undefined;
  const updated = await applyUpdate(ctx, defect.id, { ...(status ? { status } : {}), details: { trackerState: ext.state } });
  const runId = updated.details?.retestRunId;
  if (status && runId && runId !== defect.details?.retestRunId) {
    await tracker.addComment(defect.external.id, `s1-pilot queued a re-test (run ${runId}) after this issue was resolved.`).catch((error: unknown) => {
      ctx.log.warn({ err: error instanceof Error ? error.message : 'unknown' }, 'tracker comment failed');
    });
  }
  return { status: updated.status, changed: status !== undefined };
}

/**
 * Polls the tracker status of pushed, not yet closed defects (all projects, or one) and updates the local ones.
 * Errors of single defects are logged and skipped.
 */
export async function syncDefects(ctx: Context, projectId?: string): Promise<{ checked: number; updated: number }> {
  const projects = projectId ? [await ctx.repos.projects.get(ctx.db, projectId)] : await ctx.repos.projects.list(ctx.db);
  let checked = 0;
  let updated = 0;
  for (const project of projects) {
    if (!project) continue;
    const mapping = await getMapping(ctx, project.id);
    const defects = (await ctx.repos.defects.listByProject(ctx.db, project.id)).filter((d) => d.external && d.status !== 'closed');
    for (const defect of defects) {
      const ref = defect.external;
      if (!ref) continue;
      try {
        const tracker = await trackerFor(ctx, ref.provider, mapping);
        const result = await applyExternalStatus(ctx, defect, tracker, await tracker.getStatus(ref.id));
        checked += 1;
        if (result.changed) updated += 1;
      } catch (error) {
        ctx.log.warn({ defect: defectKey(defect), provider: ref.provider, err: error instanceof Error ? error.message : 'unknown' }, 'tracker sync failed');
      }
    }
  }
  if (updated > 0) ctx.runtime.live.notifyWorkspace();
  return { checked, updated };
}

/** Status carried by an inbound webhook payload (or undefined when it has none). */
export function statusFromWebhook(provider: TrackerProvider, payload: unknown): { externalId: string; repo?: string; status?: ExternalStatus } | undefined {
  const p = payload as Record<string, unknown> | null;
  const issue = p?.['issue'] as Record<string, unknown> | undefined;
  if (!issue) return undefined;
  if (provider === 'jira') {
    const key = issue['key'];
    if (typeof key !== 'string') return undefined;
    const st = (issue['fields'] as { status?: { name?: string; statusCategory?: { key?: string } } } | undefined)?.status;
    return { externalId: key, ...(st?.statusCategory?.key ? { status: { name: st.name ?? st.statusCategory.key, state: st.statusCategory.key } } : {}) };
  }
  if (provider === 'github') {
    const number = issue['number'];
    const state = issue['state'];
    if (typeof number !== 'number' || typeof state !== 'string') return undefined;
    const reason = issue['state_reason'];
    const repo = (p?.['repository'] as { full_name?: string } | undefined)?.full_name;
    return {
      externalId: String(number),
      ...(repo ? { repo } : {}),
      status: { name: state, state: state === 'closed' && reason === 'not_planned' ? 'closed:not_planned' : state },
    };
  }
  return undefined;
}

/** Handles a Jira / GitHub webhook: finds the pushed defect and applies the status. Returns whether a defect matched. */
export async function handleWebhook(ctx: Context, provider: TrackerProvider, payload: unknown): Promise<boolean> {
  const parsed = statusFromWebhook(provider, payload);
  if (!parsed) return false;
  for (const project of await ctx.repos.projects.list(ctx.db)) {
    const mapping = await getMapping(ctx, project.id);
    if (parsed.repo && mapping?.githubRepo && mapping.githubRepo.toLowerCase() !== parsed.repo.toLowerCase()) continue;
    const defect = (await ctx.repos.defects.listByProject(ctx.db, project.id)).find((d) => d.external?.provider === provider && d.external.id === parsed.externalId);
    if (!defect) continue;
    const tracker = await trackerFor(ctx, provider, mapping);
    await applyExternalStatus(ctx, defect, tracker, parsed.status ?? (await tracker.getStatus(parsed.externalId)));
    ctx.runtime.live.notifyWorkspace();
    return true;
  }
  return false;
}

/** Default poll interval: 10 minutes. */
export const TRACKER_POLL_MS = 10 * 60_000;

/** Starts the periodic sync; returns a stop function. The timer does not keep the process alive. */
export function startTrackerSync(makeCtx: () => Context, intervalMs: number = TRACKER_POLL_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    const ctx = makeCtx();
    syncDefects(ctx)
      .catch((error: unknown) => ctx.log.warn({ err: error instanceof Error ? error.message : 'unknown' }, 'tracker poll failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
