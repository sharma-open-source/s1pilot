import { ProjectKeySchema } from '@s1pilot/domain';
import { syncStatus } from '@s1pilot/sync';
import { z } from 'zod';

import { publicProcedure } from '../trpc.js';

import { requireProject } from './helpers.js';

/**
 * Whether the DB and the `.s1pilot/` tests-as-code files (under the server data dir) agree (S-029).
 * `clean: true` means a fresh export would not change any file.
 */
export const syncStatusProcedure = publicProcedure
  .input(z.object({ projectKey: ProjectKeySchema }))
  .query(async ({ ctx, input }) => {
    const project = await requireProject(ctx, input.projectKey);
    const status = await syncStatus(ctx.db, project.id, ctx.config.dataDir);
    if (status === 'clean') return { clean: true as const, changedFiles: [] as string[], conflicts: [] };
    return { clean: false as const, changedFiles: status.changedFiles, conflicts: status.conflicts };
  });
