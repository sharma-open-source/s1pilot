import { createFileRoute } from '@tanstack/react-router';

import { AnalyticsPage } from '@/features/analytics/AnalyticsPage';
import { parseSearch, parseView } from '@/features/analytics/model';

export const Route = createFileRoute('/p/$key/analytics/$view')({
  validateSearch: parseSearch,
  component: AnalyticsRoute,
});

function AnalyticsRoute() {
  const { key, view } = Route.useParams();
  const search = Route.useSearch();
  return <AnalyticsPage projectKey={key} view={parseView(view)} search={search} />;
}
