import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { parsePageParam } from '@/components/ui';
import { RunsListPage, type RunsListSearch } from '@/features/run-report/RunsListPage';

export const Route = createFileRoute('/p/$key/reports/')({
  validateSearch: (search: Record<string, unknown>): RunsListSearch => {
    const page = parsePageParam(search['page']);
    return page !== undefined ? { page } : {};
  },
  component: ReportsRoute,
});

function ReportsRoute() {
  const { key } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <RunsListPage
      projectKey={key}
      reports
      search={search}
      onSearch={(next) => void navigate({ to: '/p/$key/reports', params: { key }, search: next })}
    />
  );
}
