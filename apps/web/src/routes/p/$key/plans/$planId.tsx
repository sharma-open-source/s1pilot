import { createFileRoute } from '@tanstack/react-router';

import { PlanBuilderPage } from '@/features/plans/PlanBuilderPage';

export const Route = createFileRoute('/p/$key/plans/$planId')({
  component: () => {
    const { key, planId } = Route.useParams();
    return <PlanBuilderPage projectKey={key} planId={planId} />;
  },
});
