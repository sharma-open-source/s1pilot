import { createFileRoute } from '@tanstack/react-router';

import { ComponentsDemo } from '@/components/app/ComponentsDemo';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/ui/misc';

export const Route = createFileRoute('/_dev/components')({
  component: () =>
    import.meta.env.DEV ? (
      <ComponentsDemo />
    ) : (
      <>
        <PageHeader title="Page not found" />
        <EmptyState>There is nothing at this address.</EmptyState>
      </>
    ),
});
