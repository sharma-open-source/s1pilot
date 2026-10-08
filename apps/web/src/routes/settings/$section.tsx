import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/settings/$section')({
  component: () => <PlaceholderPage title="Settings" spec="S-059" />,
});
