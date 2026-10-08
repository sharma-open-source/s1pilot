import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/review/')({
  component: () => <PlaceholderPage title="Review queue" spec="S-047" />,
});
