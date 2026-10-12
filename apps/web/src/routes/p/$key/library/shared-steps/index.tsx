import { createFileRoute } from '@tanstack/react-router';

import { SharedStepsPage } from '@/features/shared-steps/SharedStepsPage';

export const Route = createFileRoute('/p/$key/library/shared-steps/')({
  component: () => <SharedStepsPage projectKey={Route.useParams().key} />,
});
