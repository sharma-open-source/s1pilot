import { useCallback, useEffect, useRef, useState } from 'react';

import { BasicsStep } from './BasicsStep';
import { EnvironmentsStep } from './EnvironmentsStep';
import { FirstTestsStep } from './FirstTestsStep';
import { LoginStep } from './LoginStep';
import {
  clearDraft,
  draftFromProject,
  loadDraft,
  saveDraft,
  WIZARD_STEPS,
  type WizardDraft,
  type WizardStep,
} from './model';
import { ModelsStep } from './ModelsStep';
import type { StepProps } from './shared';

import { WizardStepper } from '@/components/app/WizardStepper';
import { Callout, Skeleton } from '@/components/ui';
import { trpc } from '@/lib/trpc';

export interface ProjectWizardProps {
  /** Edit this existing project instead of creating one; the draft is seeded from the server. */
  projectKey?: string;
  step: WizardStep;
  /** Called to move between steps (the route updates `?step=`). */
  onStepChange: (step: WizardStep, opts?: { replace?: boolean }) => void;
  /** Leave without finishing. */
  onExit: () => void;
  /** Leave for an in-app path once done; the draft is cleared first. */
  onFinish: (to: string) => void;
}

const STEP_VIEWS: Record<WizardStep, (p: StepProps) => JSX.Element> = {
  basics: BasicsStep,
  environments: EnvironmentsStep,
  models: ModelsStep,
  login: LoginStep,
  'first-tests': FirstTestsStep,
};

/** Five-step new-project wizard. Draft state lives in sessionStorage until finish; the project exists after step 1. */
export function ProjectWizard(props: ProjectWizardProps) {
  const { projectKey } = props;
  const project = trpc.projects.get.useQuery(projectKey ?? '', {
    enabled: projectKey !== undefined,
  });
  const envs = trpc.environments.list.useQuery(
    { projectKey: projectKey ?? '' },
    { enabled: projectKey !== undefined },
  );
  const models = trpc.models.getSettings.useQuery(projectKey ?? '', {
    enabled: projectKey !== undefined,
  });
  if (projectKey === undefined) return <WizardBody {...props} initial={loadDraft()} />;
  if (project.isError || envs.isError || models.isError) {
    return (
      <Callout tone="danger">
        Could not load project {projectKey}. Check the key and try again.
      </Callout>
    );
  }
  if (!project.data || !envs.data || !models.data) return <Skeleton className="h-64 w-full" />;
  const defaultEnv =
    envs.data.find((e) => e.id === project.data.defaultEnvironmentId) ?? envs.data[0];
  const initial = draftFromProject({
    key: project.data.key,
    name: project.data.name,
    baseUrl: defaultEnv?.baseUrl ?? '',
    settings: models.data.settings as never,
    dataPolicy: project.data.dataPolicy as never,
  });
  return <WizardBody {...props} initial={initial} editing />;
}

function WizardBody(props: ProjectWizardProps & { initial: WizardDraft; editing?: boolean }) {
  const { step, onStepChange, onExit, onFinish, initial: seed } = props;
  const [, setVersion] = useState(0);
  // The ref is the source of truth: `patch` updates it synchronously, so a route change that lands in the same tick
  // as a patch (create project, then go to the next step) never renders against a stale draft.
  const [initial] = useState(seed);
  const draftRef = useRef<WizardDraft>(initial);
  const draft = draftRef.current;

  const patch = useCallback((p: Partial<WizardDraft>) => {
    draftRef.current = { ...draftRef.current, ...p };
    setVersion((v) => v + 1);
    // Editing an existing project must not leave a draft behind that a later "new project" would pick up.
    if (props.editing !== true) saveDraft(draftRef.current);
  }, []);

  // Later steps need the project; send a fresh visit back to the first step.
  const blocked = step !== 'basics' && draft.createdKey === undefined;
  useEffect(() => {
    if (blocked) onStepChange('basics', { replace: true });
  }, [blocked, onStepChange]);

  if (blocked) return null;
  const View = STEP_VIEWS[step];
  return (
    <>
      <WizardStepper steps={WIZARD_STEPS} current={step} />
      <View
        key={step}
        draft={draft}
        patch={patch}
        go={onStepChange}
        onExit={onExit}
        onFinish={(to) => {
          if (props.editing !== true) clearDraft();
          onFinish(to);
        }}
      />
    </>
  );
}
