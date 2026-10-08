import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search['q'] === 'string' && search['q'] !== '' ? { q: search['q'] } : {},
  // Global search is out of scope for S-040 (the dashboard only links here); no owning spec exists yet.
  component: () => <PlaceholderPage title="Search" spec="a later spec" />,
});
