import { createFileRoute, useNavigate } from '@tanstack/react-router';

import { CaseEditorPage } from '@/features/case-editor/CaseEditorPage';

export const Route = createFileRoute('/p/$key/cases/$caseKey/$tab')({
  component: CaseEditorRoute,
});

function CaseEditorRoute() {
  const { key, caseKey, tab } = Route.useParams();
  const navigate = useNavigate();
  return <CaseEditorPage projectKey={key} caseKey={caseKey} tab={tab} navigate={(to) => void navigate({ to: to as never })} />;
}
