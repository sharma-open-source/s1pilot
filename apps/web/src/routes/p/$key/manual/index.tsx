import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/manual/')({
  component: () => <PlaceholderPage title="Manual testing" spec="S-055" />,
});
