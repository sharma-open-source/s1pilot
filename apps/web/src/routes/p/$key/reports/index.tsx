import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/reports/')({
  component: () => <PlaceholderPage title="Reports" spec="S-046" />,
});
