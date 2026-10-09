import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';

import { PageHeader } from '@/components/app/PageHeader';
import { Breadcrumb } from '@/components/ui';
import { parseStep, type WizardStep } from '@/features/wizard/model';
import { ProjectWizard } from '@/features/wizard/ProjectWizard';

export const Route = createFileRoute('/projects/new')({
  validateSearch: (search: Record<string, unknown>): { step: WizardStep; project?: string } => ({
    step: parseStep(search['step']),
    ...(typeof search['project'] === 'string' && search['project'] !== ''
      ? { project: search['project'] }
      : {}),
  }),
  component: NewProjectPage,
});

function NewProjectPage() {
  const { step, project } = Route.useSearch();
  const navigate = useNavigate();
  const onStepChange = useCallback(
    (next: WizardStep, opts?: { replace?: boolean }) => {
      void navigate({
        to: '/projects/new',
        search: { step: next, ...(project ? { project } : {}) },
        replace: opts?.replace ?? false,
      });
    },
    [navigate, project],
  );
  return (
    <>
      <PageHeader
        eyebrow={
          <Breadcrumb
            items={[
              { label: 'Workspace', to: '/' },
              { label: project ? 'Project setup' : 'New project' },
            ]}
          />
        }
        title={project ? `Project setup · ${project}` : 'Create project'}
      />
      <ProjectWizard
        step={step}
        {...(project ? { projectKey: project } : {})}
        onStepChange={onStepChange}
        onExit={() =>
          void navigate({
            to: project ? ('/p/$key/cases' as never) : '/',
            ...(project ? { params: { key: project } as never } : {}),
          })
        }
        onFinish={(to) => void navigate({ to: to as never })}
      />
    </>
  );
}
