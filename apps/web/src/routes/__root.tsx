import { createRootRoute, Outlet } from '@tanstack/react-router';

import { AppShell } from '@/components/app/AppShell';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/ui/misc';

export const Route = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  notFoundComponent: () => (
    <>
      <PageHeader title="Page not found" />
      <EmptyState>There is nothing at this address. Use the navigation to pick a screen.</EmptyState>
    </>
  ),
});
