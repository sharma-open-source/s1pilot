import { useEffect, useState } from 'react';

import { Button, Callout, Dialog, Field, Input, Select } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

const NEW = '__new__';

interface Props {
  projectKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseIds: string[];
  /** Called with a human summary after the cases were added. */
  onDone: (message: string, planId: string) => void;
}

/** "Add to plan" from the case list: append the selection to a hand-picked plan, or start a new one. */
export function AddToPlanDialog({ projectKey, open, onOpenChange, caseIds, onDone }: Props) {
  const utils = trpc.useUtils();
  const plans = trpc.plans.list.useQuery({ projectKey }, { enabled: open });
  const envs = trpc.environments.list.useQuery({ projectKey }, { enabled: open });
  const create = trpc.plans.create.useMutation();
  const update = trpc.plans.update.useMutation();
  const manual = (plans.data ?? []).filter((p) => p.selection.kind === 'list');
  const [target, setTarget] = useState(NEW);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setTarget(NEW);
      setName('');
      setError(null);
    }
  }, [open]);

  const pending = create.isPending || update.isPending;
  const submit = async () => {
    setError(null);
    try {
      if (target === NEW) {
        if (name.trim() === '') {
          setError('Give the new plan a name');
          return;
        }
        const env = (envs.data ?? []).find((e) => !e.readOnly) ?? envs.data?.[0];
        if (env === undefined) {
          setError('Add an environment first; plans need somewhere to run.');
          return;
        }
        const plan = await create.mutateAsync({
          projectKey,
          name: name.trim(),
          selection: { kind: 'list', caseIds },
          matrix: [{ environmentId: env.id, browser: 'chromium' }],
          retries: 1,
          parallelism: 4,
          mode: 'replay-heal',
          unattended: 'block',
          exitCriteria: [],
          checks: { a11y: false, consoleErrors: true, visual: false, video: false },
        });
        await utils.plans.list.invalidate();
        onOpenChange(false);
        onDone(`Created plan ${plan.name} with ${caseIds.length} ${caseIds.length === 1 ? 'case' : 'cases'}`, plan.id);
      } else {
        const plan = manual.find((p) => p.id === target);
        if (plan === undefined || plan.selection.kind !== 'list') return;
        const merged = [...new Set([...plan.selection.caseIds, ...caseIds])];
        await update.mutateAsync({ id: plan.id, patch: { selection: { kind: 'list', caseIds: merged } } });
        await Promise.all([utils.plans.list.invalidate(), utils.plans.get.invalidate(plan.id)]);
        onOpenChange(false);
        onDone(`Added ${merged.length - plan.selection.caseIds.length} new cases to plan ${plan.name}`, plan.id);
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add to plan"
      description={`Adds ${caseIds.length} selected ${caseIds.length === 1 ? 'case' : 'cases'} to a hand-picked plan.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={pending || plans.isLoading} onClick={() => void submit()}>
            {pending ? 'Adding…' : 'Add to plan'}
          </Button>
        </>
      }
    >
      {error !== null && <Callout tone="danger">{error}</Callout>}
      {plans.isError && <Callout tone="danger">Could not load plans: {errorMessage(plans.error)}</Callout>}
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Plan">
          {(id) => (
            <Select id={id} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value={NEW}>New plan…</option>
              {manual.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.release !== undefined && p.release !== '' ? `${p.release} · ` : ''}
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {target === NEW && (
          <Field label="New plan name">{(id) => <Input id={id} value={name} placeholder="Checkout regression" onChange={(e) => setName(e.target.value)} />}</Field>
        )}
        <button type="submit" className="sr-only" tabIndex={-1}>
          Add
        </button>
      </form>
    </Dialog>
  );
}
