import { createFileRoute } from '@tanstack/react-router';

import { LiveRunPage } from '@/features/live-run/LiveRunPage';

export const Route = createFileRoute('/p/$key/runs/$runId/live')({
  component: LiveRoute,
});

function LiveRoute() {
  const { key, runId } = Route.useParams();
  return <LiveRunPage key={runId} projectKey={key} runId={runId} />;
}
