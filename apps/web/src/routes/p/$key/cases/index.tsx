import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/cases/')({
  component: () => <PlaceholderPage title="Test cases" spec="S-043" />,
});
