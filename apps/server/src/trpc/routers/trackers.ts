import { IdSchema, ProjectKeySchema, S1PilotError } from '@s1pilot/domain';
import { createTracker, type TrackerCredentials } from '@s1pilot/integrations';
import { z } from 'zod';

import {
  MappingRecordSchema,
  TrackerProviderSchema,
  TRACKER_PROVIDERS,
  connectionInfo,
  deleteConnection,
  getMapping,
  loadCredentials,
  mappingLabel,
  pushDefect,
  rotateWebhook,
  saveConnection,
  setMapping,
  syncDefects,
  toTrackerMapping,
} from '../../trackers/service.js';
import { publicProcedure, router } from '../trpc.js';

import { requireWriter } from './defects.js';
import { requireProject } from './helpers.js';
import { requireSession } from './tokens.js';

const CredentialsInput = z.object({
  provider: TrackerProviderSchema,
  baseUrl: z.string().trim().url().max(300).optional().or(z.literal('')),
  email: z.string().trim().max(200).optional(),
  /** Omit to keep the stored token (editing a connection). */
  token: z.string().max(2000).optional(),
});

/** Merges the form with the stored credentials; the stored token is reused when none is entered. */
async function resolveCredentials(ctx: Parameters<typeof loadCredentials>[0], input: z.infer<typeof CredentialsInput>): Promise<TrackerCredentials> {
  const stored = await loadCredentials(ctx, input.provider);
  const token = input.token && input.token !== '' ? input.token : stored?.token;
  if (!token) throw new S1PilotError('TRACKER_CONFIG', 'Enter an API token');
  return { baseUrl: input.baseUrl || undefined, email: input.email || undefined, token };
}

/**
 * `trackers` router (S-064): connection per tracker (credentials write-only, encrypted at rest), per-project
 * mapping, push of defects and status sync. No procedure returns a credential.
 */
export const trackersRouter = router({
  /** Connection state of Jira, GitHub and Linear (no credentials). */
  list: publicProcedure.query(async ({ ctx }) => Promise.all(TRACKER_PROVIDERS.map((p) => connectionInfo(ctx, p)))),

  /** Checks credentials against the tracker without saving them. */
  test: publicProcedure.input(CredentialsInput).mutation(async ({ ctx, input }) => {
    requireSession(ctx);
    return createTracker(input.provider, await resolveCredentials(ctx, input)).testConnection();
  }),

  /** Tests, then stores the connection (token encrypted). Fails when the tracker rejects the credentials. */
  connect: publicProcedure.input(CredentialsInput).mutation(async ({ ctx, input }) => {
    requireSession(ctx);
    const creds = await resolveCredentials(ctx, input);
    const result = await createTracker(input.provider, creds).testConnection();
    if (!result.ok) throw new S1PilotError('TRACKER_CONNECTION', result.detail);
    await saveConnection(ctx, input.provider, creds);
    return { ...(await connectionInfo(ctx, input.provider)), detail: result.detail };
  }),

  disconnect: publicProcedure.input(TrackerProviderSchema).mutation(async ({ ctx, input }) => {
    requireSession(ctx);
    await deleteConnection(ctx, input);
    return connectionInfo(ctx, input);
  }),

  /** New inbound webhook secret for Jira / GitHub. The returned path is shown once. */
  rotateWebhook: publicProcedure.input(z.enum(['jira', 'github'])).mutation(async ({ ctx, input }) => {
    requireSession(ctx);
    return { path: await rotateWebhook(ctx, input) };
  }),

  /** The tracker mapped for a project, with the label used by the Defects eyebrow and whether pushing is possible. */
  mapping: publicProcedure.input(z.object({ projectKey: ProjectKeySchema })).query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const m = await getMapping(ctx, project.id);
    if (!m) return null;
    const connected = (await connectionInfo(ctx, m.provider)).connected;
    return { ...m, connected, label: mappingLabel(m) };
  }),

  /** Maps a project to a tracker target; `null` removes the mapping. */
  setMapping: publicProcedure
    .input(z.object({ projectKey: ProjectKeySchema, mapping: MappingRecordSchema.nullable() }))
    .mutation(async ({ ctx, input }) => {
      requireSession(ctx);
      const project = await requireProject(ctx, input.projectKey);
      const m = input.mapping;
      if (m) {
        const target = toTrackerMapping(m);
        const missing =
          m.provider === 'jira' ? !target.jiraProject : m.provider === 'github' ? !target.githubRepo || !/^[\w.-]+\/[\w.-]+$/.test(target.githubRepo) : !target.linearTeamId;
        if (missing) {
          throw new S1PilotError('TRACKER_CONFIG', m.provider === 'github' ? 'Enter the repository as owner/name' : `Enter the ${m.provider === 'jira' ? 'Jira project key' : 'Linear team id'}`);
        }
      }
      await setMapping(ctx, project.id, m);
      return m ? { ...m, connected: (await connectionInfo(ctx, m.provider)).connected, label: mappingLabel(m) } : null;
    }),

  /** Creates the issue for a defect in the mapped tracker and stores the link. */
  push: publicProcedure.input(IdSchema).mutation(async ({ ctx, input }) => {
    requireWriter(ctx);
    const defect = await pushDefect(ctx, input);
    ctx.runtime.live.notifyWorkspace();
    return defect;
  }),

  /** Polls the trackers now (the server also polls every 10 minutes). */
  syncNow: publicProcedure.input(z.object({ projectKey: ProjectKeySchema.optional() }).default({})).mutation(async ({ ctx, input }) => {
    requireWriter(ctx);
    const project = input.projectKey ? await requireProject(ctx, input.projectKey) : undefined;
    return syncDefects(ctx, project?.id);
  }),
});
