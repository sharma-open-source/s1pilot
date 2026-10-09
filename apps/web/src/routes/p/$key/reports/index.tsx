import { createFileRoute } from '@tanstack/react-router';

import { RunsListPage } from '@/features/run-report/RunsListPage';

export const Route = createFileRoute('/p/$key/reports/')({
  component: ReportsRoute,
});

function ReportsRoute() {
  const { key } = Route.useParams();
  return <RunsListPage projectKey={key} reports />;
}
