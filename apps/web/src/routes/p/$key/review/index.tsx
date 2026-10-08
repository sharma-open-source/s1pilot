import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { parseStatus, parseTab } from '@/features/review/model';
import { ReviewPage, type ReviewSearch } from '@/features/review/ReviewPage';

export const Route = createFileRoute('/p/$key/review/')({
  validateSearch: (search: Record<string, unknown>): ReviewSearch => {
    const tab = parseTab(search['tab']);
    const status = parseStatus(search['status']);
    const item = typeof search['item'] === 'string' && search['item'] !== '' ? search['item'] : undefined;
    return { ...(tab ? { tab } : {}), ...(item ? { item } : {}), ...(status && status !== 'pending' ? { status } : {}) };
  },
  component: ReviewRoute,
});

function ReviewRoute() {
  const { key } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <ReviewPage
      projectKey={key}
      search={search}
      onSearch={(next, opts) => void navigate({ to: '/p/$key/review', params: { key }, search: next, replace: opts?.replace ?? false })}
    />
  );
}
