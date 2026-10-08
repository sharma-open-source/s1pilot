import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/manual/$sessionId')({
  component: () => <PlaceholderPage title="Manual run" spec="S-055" />,
});
