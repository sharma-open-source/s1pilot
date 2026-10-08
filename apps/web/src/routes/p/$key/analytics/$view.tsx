import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/analytics/$view')({
  component: () => <PlaceholderPage title="Analytics" spec="S-057" />,
});
