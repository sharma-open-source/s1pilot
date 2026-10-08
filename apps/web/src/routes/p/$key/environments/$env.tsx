import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/environments/$env')({
  component: () => <PlaceholderPage title="Environments" spec="S-042" />,
});
