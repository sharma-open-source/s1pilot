import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/')({
  component: () => <PlaceholderPage title="Dashboard" spec="S-040" />,
});
