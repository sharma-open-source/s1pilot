import { createFileRoute } from '@tanstack/react-router';

import { EnvironmentsPage } from '@/features/environments/EnvironmentsPage';

export const Route = createFileRoute('/p/$key/environments/')({
  component: () => <EnvironmentsPage projectKey={Route.useParams().key} />,
});
