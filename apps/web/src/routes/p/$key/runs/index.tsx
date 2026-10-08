import { createFileRoute } from '@tanstack/react-router';

import { RunsListPage } from '@/features/run-report/RunsListPage';

export const Route = createFileRoute('/p/$key/runs/')({
  component: RunsRoute,
});

function RunsRoute() {
  const { key } = Route.useParams();
  return <RunsListPage projectKey={key} />;
}
