import { getVersion } from '../version.js';

import { environmentsRouter } from './routers/environments.js';
import { modelsRouter } from './routers/models.js';
import { projectsRouter } from './routers/projects.js';
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
});

export type AppRouter = typeof appRouter;
