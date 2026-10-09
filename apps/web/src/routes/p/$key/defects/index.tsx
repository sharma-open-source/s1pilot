import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { DefectsPage } from '@/features/defects/DefectsPage';
import { parseSearch } from '@/features/defects/model';

export const Route = createFileRoute('/p/$key/defects/')({
  validateSearch: parseSearch,
  component: DefectsRoute,
});

function DefectsRoute() {
  const { key } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <DefectsPage
      projectKey={key}
      search={search}
      onSearch={(next, opts) => void navigate({ to: '/p/$key/defects', params: { key }, search: next, replace: opts?.replace ?? false })}
    />
  );
}
