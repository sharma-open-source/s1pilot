import { useState } from 'react';

import { ResultLine, WizardFooter, type StepProps } from './shared';

import { Button, Callout, Card, Field, Input } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

type Phase = 'idle' | 'starting' | 'recording' | 'finishing' | 'saved' | 'error';

/** Step 4 (optional): record a login, pick a flow, or skip. Uses the S-038 `auth.*` procedures. */
export function LoginStep({ draft, patch, go }: StepProps) {
  const utils = trpc.useUtils();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showFlow, setShowFlow] = useState(draft.login.choice === 'flow');
  const [flowName, setFlowName] = useState(draft.login.flowName);

  const projectKey = draft.createdKey ?? '';
  const environmentId = draft.envRows?.[0]?.envId;
  const base = { projectKey, name: 'login-as-customer', ...(environmentId ? { environmentId } : {}) };

  const record = async () => {
    setError(null);
    setPhase('starting');
    try {
      await utils.client.auth.record.mutate(base);
      setPhase('recording');
    } catch (err) {
      setError(errorMessage(err));
      setPhase('error');
    }
  };

  const finish = async () => {
    setPhase('finishing');
    try {
      await utils.client.auth.finishRecording.mutate(base);
      patch({ login: { choice: 'recorded', flowName } });
      setPhase('saved');
    } catch (err) {
      setError(errorMessage(err));
      setPhase('error');
    }
  };

  const next = async (choice: 'recorded' | 'flow' | 'skipped') => {
    if (choice === 'flow') {
      try {
        // The flow runs (and is refreshed) by the server; here it is only registered under the login name.
        await utils.client.auth.saveFlow.mutate({ ...base, flowId: flowName.trim() });
      } catch (err) {
        setError(errorMessage(err));
        setPhase('error');
        return;
      }
    }
    patch({ login: { choice, flowName } });
    go('first-tests');
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void next(phase === 'saved' ? 'recorded' : showFlow && flowName.trim() !== '' ? 'flow' : 'skipped');
      }}
      className="flex flex-col gap-6"
    >
      <Card aria-label="Login setup" className="flex flex-col gap-[18px] p-[22px]">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-fg">Login setup</h2>
          <p className="text-sm text-secondary">
            Optional. Log in once and every run reuses the saved session. You can also set this up later from Environments.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="primary" onClick={() => void record()} disabled={phase === 'starting' || phase === 'recording' || phase === 'finishing'}>
            Record a login
          </Button>
          <Button variant="secondary" aria-pressed={showFlow} onClick={() => setShowFlow((s) => !s)}>
            Use a flow
          </Button>
          <Button variant="secondary" onClick={() => void next('skipped')}>
            Skip
          </Button>
        </div>
        <ResultLine
          state={phase === 'starting' || phase === 'finishing' ? 'pending' : phase === 'saved' ? 'success' : phase === 'error' ? 'error' : 'idle'}
          progress={phase === 'starting' ? 'Opening a browser…' : 'Saving the session…'}
          success="Login saved for the dev environment"
          error={error ?? ''}
        />
        {phase === 'recording' && (
          <Callout tone="info-ai">
            <div className="flex flex-wrap items-center gap-3">
              <span>A browser window is open. Log in to your app there, then press Done.</span>
              <Button variant="ink" size="sm" onClick={() => void finish()}>
                Done
              </Button>
            </div>
          </Callout>
        )}
        {showFlow && (
          <Field label="Shared step or flow name" hint="The flow runs before each case that needs this login.">
            {(id) => (
              <Input
                id={id}
                mono
                autoComplete="off"
                placeholder="login-as-customer"
                value={flowName}
                onChange={(e) => {
                  setFlowName(e.target.value);
                  patch({ login: { choice: 'flow', flowName: e.target.value } });
                }}
              />
            )}
          </Field>
        )}
      </Card>
      <WizardFooter onBack={() => go('models')} continueLabel="Continue to first tests" />
    </form>
  );
}
