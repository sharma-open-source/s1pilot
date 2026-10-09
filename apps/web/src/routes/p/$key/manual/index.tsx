import { createFileRoute } from '@tanstack/react-router';

import { ManualQueuePage } from '@/features/manual/ManualQueuePage';

export const Route = createFileRoute('/p/$key/manual/')({
  component: ManualQueueRoute,
});

function ManualQueueRoute() {
  const { key } = Route.useParams();
  return <ManualQueuePage projectKey={key} />;
}
