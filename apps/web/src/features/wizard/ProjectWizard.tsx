import { useCallback, useEffect, useRef, useState } from 'react';

import { BasicsStep } from './BasicsStep';
import { EnvironmentsStep } from './EnvironmentsStep';
import { FirstTestsStep } from './FirstTestsStep';
import { LoginStep } from './LoginStep';
import { clearDraft, loadDraft, saveDraft, WIZARD_STEPS, type WizardDraft, type WizardStep } from './model';
import { ModelsStep } from './ModelsStep';
import type { StepProps } from './shared';

import { WizardStepper } from '@/components/app/WizardStepper';

export interface ProjectWizardProps {
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
export function ProjectWizard({ step, onStepChange, onExit, onFinish }: ProjectWizardProps) {
  const [, setVersion] = useState(0);
  // The ref is the source of truth: `patch` updates it synchronously, so a route change that lands in the same tick
  // as a patch (create project, then go to the next step) never renders against a stale draft.
  const [initial] = useState(loadDraft);
  const draftRef = useRef<WizardDraft>(initial);
  const draft = draftRef.current;

  const patch = useCallback((p: Partial<WizardDraft>) => {
    draftRef.current = { ...draftRef.current, ...p };
    setVersion((v) => v + 1);
    saveDraft(draftRef.current);
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
          clearDraft();
          onFinish(to);
        }}
      />
    </>
  );
}
