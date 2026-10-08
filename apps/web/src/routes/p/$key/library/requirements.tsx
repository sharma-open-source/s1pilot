import { createFileRoute } from '@tanstack/react-router';

import { RequirementsPage } from '@/features/cases/LibraryPages';

export const Route = createFileRoute('/p/$key/library/requirements')({
  component: () => <RequirementsPage projectKey={Route.useParams().key} />,
});
