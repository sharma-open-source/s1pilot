import { getVersion } from '../version.js';

import { authRouter } from './routers/auth.js';
import { casesRouter } from './routers/cases.js';
import { dashboardRouter } from './routers/dashboard.js';
import { environmentsRouter } from './routers/environments.js';
import { modelsRouter } from './routers/models.js';
import { projectsRouter } from './routers/projects.js';
import { requirementsRouter } from './routers/requirements.js';
import { runsRouter } from './routers/runs.js';
import { sharedStepsRouter } from './routers/shared-steps.js';
import { suitesRouter } from './routers/suites.js';
import { syncStatusProcedure } from './routers/sync-status.js';
import { createCallerFactory, publicProcedure, router, trpcCodeFor } from './trpc.js';

export { createCallerFactory, publicProcedure, router, trpcCodeFor };

/** Root router. Further domain routers are added by S-033+. */
export const appRouter = router({
  health: publicProcedure.query(({ ctx }) => ({
    ok: true as const,
    version: getVersion(),
    mode: ctx.config.mode,
  })),
  projects: projectsRouter,
  environments: environmentsRouter,
  models: modelsRouter,
  suites: suitesRouter,
  cases: casesRouter,
  sharedSteps: sharedStepsRouter,
  requirements: requirementsRouter,
  runs: runsRouter,
  syncStatus: syncStatusProcedure,
  dashboard: dashboardRouter,
  auth: authRouter,
});

export type AppRouter = typeof appRouter;
