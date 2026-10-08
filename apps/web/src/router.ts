import { createRouter } from '@tanstack/react-router';

import { routeTree } from './routeTree.gen';

/** The app router (file-based routes in `src/routes`). */
export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
