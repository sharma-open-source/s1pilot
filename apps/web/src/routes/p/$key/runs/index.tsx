import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/runs/')({
  component: () => <PlaceholderPage title="Runs" spec="S-045" />,
});
