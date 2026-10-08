import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/plans/')({
  component: () => <PlaceholderPage title="Test plans" spec="S-050" />,
});
