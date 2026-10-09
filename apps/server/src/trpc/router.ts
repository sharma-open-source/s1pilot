import { getVersion } from '../version.js';

import { analyticsRouter } from './routers/analytics.js';
import { authRouter } from './routers/auth.js';
import { calibrationRouter } from './routers/calibration.js';
import { casesRouter } from './routers/cases.js';
import { dashboardRouter } from './routers/dashboard.js';
import { defectsRouter } from './routers/defects.js';
import { environmentsRouter } from './routers/environments.js';
import { importsRouter } from './routers/imports.js';
import { manualRouter } from './routers/manual.js';
import { modelsRouter } from './routers/models.js';
import { notificationsRouter } from './routers/notifications.js';
import { plansRouter } from './routers/plans.js';
import { projectsRouter } from './routers/projects.js';
import { requirementsRouter } from './routers/requirements.js';
import { reviewsRouter } from './routers/reviews.js';
import { resultsRouter } from './routers/run-report.js';
import { runsRouter } from './routers/runs.js';
import { sharedStepsRouter } from './routers/shared-steps.js';
import { suitesRouter } from './routers/suites.js';
import { syncStatusProcedure } from './routers/sync-status.js';
import { tokensRouter } from './routers/tokens.js';
import { trackersRouter } from './routers/trackers.js';
import { triggersRouter } from './routers/triggers.js';
import { workspaceRouter } from './routers/workspace.js';
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
  plans: plansRouter,
  runs: runsRouter,
  triggers: triggersRouter,
  results: resultsRouter,
  reviews: reviewsRouter,
  defects: defectsRouter,
  manual: manualRouter,
  syncStatus: syncStatusProcedure,
  dashboard: dashboardRouter,
  analytics: analyticsRouter,
  calibration: calibrationRouter,
  auth: authRouter,
  tokens: tokensRouter,
  trackers: trackersRouter,
  workspace: workspaceRouter,
  notifications: notificationsRouter,
  imports: importsRouter,
});

export type AppRouter = typeof appRouter;
