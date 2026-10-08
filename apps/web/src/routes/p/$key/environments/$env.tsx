import { createFileRoute } from '@tanstack/react-router';

import { EnvironmentsPage } from '@/features/environments/EnvironmentsPage';

export const Route = createFileRoute('/p/$key/environments/$env')({
  component: () => {
    const { key, env } = Route.useParams();
    return <EnvironmentsPage projectKey={key} envName={env} />;
  },
});
