import { useRef, useState } from 'react';

import { ResultLine, WizardFooter, type StepProps } from './shared';

import { Button, Callout, Card, Field, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

/** Title for the draft case: the first line, trimmed to 80 characters. */
export function titleFromDescription(text: string): string {
  const first = text.trim().split('\n')[0] ?? '';
  return first.length > 80 ? `${first.slice(0, 77)}…` : first;
}

/** Step 5: describe a test in plain language, save it as a draft case and optionally run it in explore mode. */
export function FirstTestsStep({ draft, patch, go, onFinish }: StepProps) {
  const projectKey = draft.createdKey ?? '';
  const [phase, setPhase] = useState<'idle' | 'saving' | 'saved' | 'running' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const text = draft.firstTest;
  /** Description the current draft case was created from; editing the text creates a fresh draft. */
  const savedText = useRef<string | null>(null);
  const empty = text.trim() === '';
  const createCase = trpc.cases.create.useMutation();
  const createRun = trpc.runs.create.useMutation();

  /** Creates the draft case once per description; returns its key. */
  const ensureCase = async (): Promise<string> => {
    if (draft.caseKey !== undefined && savedText.current === text) return draft.caseKey;
    const created = await createCase.mutateAsync({
      projectKey,
      title: titleFromDescription(text),
      status: 'draft',
      steps: [{ action: text.trim() }],
    });
    const key = created.key;
    savedText.current = text;
    patch({ caseKey: key });
    return key;
  };

  const saveDraft = async () => {
    setError(null);
    setPhase('saving');
    try {
      await ensureCase();
      setPhase('saved');
    } catch (err) {
      setError(errorMessage(err));
      setPhase('error');
    }
  };

  const runNow = async () => {
    setError(null);
    setPhase('saving');
    try {
      const caseKey = await ensureCase();
      setPhase('running');
      const run = await createRun.mutateAsync({ projectKey, caseKeys: [caseKey], environment: 'dev', mode: 'explore' });
      const runId = run.id;
      onFinish(`/p/${projectKey}/runs/${runId}/live`);
    } catch (err) {
      setError(errorMessage(err));
      setPhase('error');
    }
  };

  const busy = phase === 'saving' || phase === 'running';

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onFinish(`/p/${projectKey}/cases`);
      }}
      className="flex flex-col gap-6"
    >
      <Card aria-label="First tests" className="flex flex-col gap-[18px] p-[22px]">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-fg">First tests</h2>
          <p className="text-sm text-secondary">
            Write what a user should be able to do. s1-pilot explores it once with AI, then you can replay it deterministically.
          </p>
        </div>
        <Field
          label="Describe a test in plain language"
          hint="Include the action that moves the flow on, for example: open the shop, add the first product to the cart and check the cart badge shows 1."
        >
          {(id) => (
            <Textarea
              id={id}
              rows={5}
              value={text}
              placeholder="Add a product to the cart and check the cart badge shows 1"
              onChange={(e) => {
                setPhase('idle');
                patch({ firstTest: e.target.value });
              }}
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="secondary" disabled={empty || busy} onClick={() => void saveDraft()}>
            Save as draft
          </Button>
          <Button variant="primary" disabled={empty || busy} onClick={() => void runNow()}>
            Run now (explore)
          </Button>
          <ResultLine
            state={busy ? 'pending' : phase === 'saved' ? 'success' : 'idle'}
            progress={phase === 'running' ? 'Starting the run…' : 'Saving the draft case…'}
            success={`Draft case ${draft.caseKey ?? ''} saved`}
          />
        </div>
        {phase === 'error' && error !== null && <Callout tone="danger">{error}</Callout>}
      </Card>
      <WizardFooter onBack={() => go('login')} continueLabel="Finish" />
    </form>
  );
}
