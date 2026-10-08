import { createFileRoute } from '@tanstack/react-router';

import { TestDataPage } from '@/features/cases/LibraryPages';

export const Route = createFileRoute('/p/$key/library/test-data')({
  component: () => <TestDataPage projectKey={Route.useParams().key} />,
});
