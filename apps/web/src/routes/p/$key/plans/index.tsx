import { createFileRoute } from '@tanstack/react-router';

import { PlansListPage } from '@/features/plans/PlansListPage';

export const Route = createFileRoute('/p/$key/plans/')({
  component: () => <PlansListPage projectKey={Route.useParams().key} />,
});
