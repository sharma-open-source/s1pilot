import { useEffect, useState } from 'react';

import { placeholdersIn } from '../shared-steps/model';

import { newUid, type DraftStep } from './model';

import { Button, Callout, Dialog, Field, Input, Select } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

interface ExtractSharedStepDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectKey: string;
  steps: DraftStep[];
  /** Called with the case's new step list: the chosen range replaced by one shared-step reference. */
  onExtracted: (steps: DraftStep[], name: string) => void;
}

/**
 * Turns a range of a case's steps into a new shared step and puts a reference to it in their place.
 * `{x}` placeholders in the range become parameters of the shared step, and the reference passes `{x}` on,
 * so the case's own test-data parameters keep working.
 */
export function ExtractSharedStepDialog({ open, onOpenChange, projectKey, steps, onExtracted }: ExtractSharedStepDialogProps) {
  const utils = trpc.useUtils();
  const create = trpc.sharedSteps.create.useMutation();
  const [name, setName] = useState('');
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setFrom(0);
    setTo(Math.max(0, steps.length - 1));
    setError(null);
    // Reset only when the dialog opens (`steps` changes while it is open must not reset the range).
  }, [open]);

  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const range = steps.slice(lo, hi + 1);
  const params = placeholdersIn(range);

  const submit = async () => {
    setError(null);
    if (name.trim() === '') {
      setError('Give the shared step a name.');
      return;
    }
    const empty = range.findIndex((s) => s.sharedStepId === undefined && s.action.trim() === '');
    if (empty >= 0) {
      setError(`Step ${lo + empty + 1} has no action.`);
      return;
    }
    try {
      const flow = await create.mutateAsync({
        projectKey,
        name: name.trim(),
        params,
        steps: range.map((s) => {
          const expected = s.expected?.trim();
          return {
            action: s.action,
            ...(expected ? { expected } : {}),
            assert: s.assert,
            inputs: s.inputs,
            ...(s.sharedStepId !== undefined ? { sharedStepId: s.sharedStepId } : {}),
            ...(s.args !== undefined ? { args: s.args } : {}),
          };
        }),
      });
      void utils.sharedSteps.list.invalidate();
      const ref: DraftStep = {
        uid: newUid(),
        action: `Run flow ${flow.name}`,
        sharedStepId: flow.id,
        args: Object.fromEntries(params.map((p) => [p, `{${p}}`])),
        assert: [],
        inputs: [],
      };
      onExtracted([...steps.slice(0, lo), ref, ...steps.slice(hi + 1)], flow.name);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const options = steps.map((s, i) => (
    <option key={s.uid} value={i}>
      {`${i + 1}. ${s.sharedStepId !== undefined ? s.action : s.action.trim() || '(empty)'}`.slice(0, 70)}
    </option>
  ));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Save steps as shared step"
      description="The chosen steps become a shared step that other test cases can insert. This case then runs it in their place."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={create.isPending} onClick={() => void submit()}>
            {create.isPending ? 'Saving…' : `Save ${range.length} step${range.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Add item to cart" autoFocus />}</Field>
        <div className="flex flex-wrap gap-3">
          <Field label="From step" className="min-w-0 flex-[1_1_200px]">
            {(id) => (
              <Select id={id} value={from} onChange={(e) => setFrom(Number(e.target.value))}>
                {options}
              </Select>
            )}
          </Field>
          <Field label="To step" className="min-w-0 flex-[1_1_200px]">
            {(id) => (
              <Select id={id} value={to} onChange={(e) => setTo(Number(e.target.value))}>
                {options}
              </Select>
            )}
          </Field>
        </div>
        {params.length > 0 && (
          <p className="m-0 text-[13px] text-secondary">
            Parameters: <span className="font-mono">{params.map((p) => `{${p}}`).join(' ')}</span>. This case passes its own values; other cases fill them in.
          </p>
        )}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
      {error !== null && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}
