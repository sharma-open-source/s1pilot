import { createFileRoute } from '@tanstack/react-router';

import { RequirementsPage } from '@/features/requirements/RequirementsPage';

export const Route = createFileRoute('/p/$key/library/requirements')({
  component: () => <RequirementsPage projectKey={Route.useParams().key} />,
});
