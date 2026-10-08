import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/cases/$caseKey/')({
  component: () => <PlaceholderPage title="Test case" spec="S-044" />,
});
