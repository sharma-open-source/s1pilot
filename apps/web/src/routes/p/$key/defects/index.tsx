import { createFileRoute } from '@tanstack/react-router';

import { PlaceholderPage } from '@/components/app/PageHeader';

export const Route = createFileRoute('/p/$key/defects/')({
  component: () => <PlaceholderPage title="Defects" spec="S-054" />,
});
