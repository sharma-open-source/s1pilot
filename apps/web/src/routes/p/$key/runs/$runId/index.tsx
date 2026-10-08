import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { parseFilter } from '@/features/run-report/model';
import { RunReportPage, type RunReportSearch } from '@/features/run-report/RunReportPage';

export const Route = createFileRoute('/p/$key/runs/$runId/')({
  validateSearch: (search: Record<string, unknown>): RunReportSearch => {
    const result = typeof search['result'] === 'string' && search['result'] !== '' ? search['result'] : undefined;
    const filter = parseFilter(search['filter']);
    return { ...(result !== undefined ? { result } : {}), ...(filter !== undefined ? { filter } : {}) };
  },
  component: RunReportRoute,
});

function RunReportRoute() {
  const { key, runId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <RunReportPage
      key={runId}
      projectKey={key}
      runId={runId}
      search={search}
      onSearch={(next, opts) =>
        void navigate({ to: '/p/$key/runs/$runId', params: { key, runId }, search: next, replace: opts?.replace ?? false })
      }
      navigate={(to) => void navigate({ to: to as never })}
    />
  );
}
