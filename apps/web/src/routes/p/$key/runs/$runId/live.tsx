import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/runs/$runId/live')({
  component: () => <PlaceholderPage title="Live run" spec="S-045" />,
});
