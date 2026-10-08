import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/runs/$runId/')({
  component: () => <PlaceholderPage title="Run report" spec="S-046" />,
});
