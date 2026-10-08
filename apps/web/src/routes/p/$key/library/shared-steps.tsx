import { createFileRoute } from '@tanstack/react-router';

import { SharedStepsPage } from '@/features/cases/LibraryPages';

export const Route = createFileRoute('/p/$key/library/shared-steps')({
  component: () => <SharedStepsPage projectKey={Route.useParams().key} />,
});
