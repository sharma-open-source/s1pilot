import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/projects/new')({
  component: () => <PlaceholderPage title="New project" spec="S-041" />,
});
