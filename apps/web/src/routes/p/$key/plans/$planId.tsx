import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/plans/$planId')({
  component: () => <PlaceholderPage title="Test plan" spec="S-050" />,
});
