import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { ManualRunPage } from '@/features/manual/ManualRunPage';

export const Route = createFileRoute('/p/$key/manual/$sessionId')({
  component: ManualRunRoute,
});

function ManualRunRoute() {
  const { key, sessionId } = Route.useParams();
  const navigate = useNavigate();
  return (
    <ManualRunPage
      projectKey={key}
      sessionId={sessionId}
      onOpenItem={(id) => void navigate({ to: '/p/$key/manual/$sessionId', params: { key, sessionId: id } })}
      onBackToQueue={() => void navigate({ to: '/p/$key/manual', params: { key } })}
    />
  );
}
