import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { PageHeader } from '@/components/app/PageHeader';
import { Breadcrumb } from '@/components/ui';
import { parseStep, type WizardStep } from '@/features/wizard/model';
import { ProjectWizard } from '@/features/wizard/ProjectWizard';

export const Route = createFileRoute('/projects/new')({
  validateSearch: (search: Record<string, unknown>): { step: WizardStep } => ({ step: parseStep(search['step']) }),
  component: NewProjectPage,
});

function NewProjectPage() {
  const { step } = Route.useSearch();
  const navigate = useNavigate();
  const onStepChange = useCallback(
    (next: WizardStep, opts?: { replace?: boolean }) => {
      void navigate({ to: '/projects/new', search: { step: next }, replace: opts?.replace ?? false });
    },
    [navigate],
  );
  return (
    <>
      <PageHeader
        eyebrow={<Breadcrumb items={[{ label: 'Workspace', to: '/' }, { label: 'New project' }]} />}
        title="Create project"
      />
      <ProjectWizard
        step={step}
        onStepChange={onStepChange}
        onExit={() => void navigate({ to: '/' })}
        onFinish={(to) => void navigate({ to: to as never })}
      />
    </>
  );
}
