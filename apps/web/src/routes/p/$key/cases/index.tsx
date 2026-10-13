import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { parsePageParam } from '@/components/ui';
import { CasesPage, type CasesSearch } from '@/features/cases/CasesPage';

export const Route = createFileRoute('/p/$key/cases/')({
  validateSearch: (search: Record<string, unknown>): CasesSearch => {
    const suite = typeof search['suite'] === 'string' && search['suite'] !== '' ? search['suite'] : undefined;
    const q = typeof search['q'] === 'string' && search['q'] !== '' ? search['q'] : undefined;
    const page = parsePageParam(search['page']);
    return { ...(suite !== undefined ? { suite } : {}), ...(q !== undefined ? { q } : {}), ...(page !== undefined ? { page } : {}) };
  },
  component: CasesRoute,
});

function CasesRoute() {
  const { key } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <CasesPage
      projectKey={key}
      search={search}
      onSearch={(next, opts) =>
        void navigate({ to: '/p/$key/cases', params: { key }, search: next, replace: opts?.replace ?? false })
      }
      navigate={(to) => void navigate({ to: to as never })}
    />
  );
}
