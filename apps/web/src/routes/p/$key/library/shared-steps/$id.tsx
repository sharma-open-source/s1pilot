import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { SharedStepEditorPage } from '@/features/shared-steps/SharedStepEditorPage';

export const Route = createFileRoute('/p/$key/library/shared-steps/$id')({
  component: SharedStepEditorRoute,
});

function SharedStepEditorRoute() {
  const { key, id } = Route.useParams();
  const navigate = useNavigate();
  return <SharedStepEditorPage projectKey={key} id={id} navigate={(to) => void navigate({ to: to as never })} />;
}
