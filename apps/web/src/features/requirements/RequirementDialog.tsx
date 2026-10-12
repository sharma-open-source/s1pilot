import { useEffect, useState } from 'react';

import { Button, Callout, Dialog, Field, Input, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

export type RequirementRow = RouterOutputs['requirements']['list'][number];

interface RequirementDialogProps {
  projectKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The requirement to edit; omitted to create one. */
  editing?: Pick<RequirementRow, 'key' | 'title' | 'description'>;
  /** Called with the saved requirement's key (requirements list already invalidated). */
  onSaved: (key: string) => void;
}

/** Create or edit a requirement: title, optional description, and on create an optional key. */
export function RequirementDialog({ projectKey, open, onOpenChange, editing, onSaved }: RequirementDialogProps) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? '');
    setKey('');
    setDescription(editing?.description ?? '');
    setError(null);
  }, [open, editing]);

  const done = (savedKey: string) => {
    void utils.requirements.list.invalidate();
    onSaved(savedKey);
    onOpenChange(false);
  };
  const create = trpc.requirements.create.useMutation({ onSuccess: (r) => done(r.key), onError: (e) => setError(errorMessage(e)) });
  const update = trpc.requirements.update.useMutation({ onSuccess: (r) => done(r.key), onError: (e) => setError(errorMessage(e)) });
  const busy = create.isPending || update.isPending;

  const submit = () => {
    setError(null);
    if (title.trim() === '') {
      setError('Enter a title');
      return;
    }
    if (editing) {
      update.mutate({ projectKey, key: editing.key, patch: { title: title.trim(), description: description.trim() } });
    } else {
      create.mutate({
        projectKey,
        title: title.trim(),
        ...(key.trim() !== '' ? { key: key.trim() } : {}),
        ...(description.trim() !== '' ? { description: description.trim() } : {}),
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${editing.key}` : 'New requirement'}
      description={editing ? 'The key stays the same: test cases refer to it.' : 'A requirement groups the test cases that cover it.'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Create requirement'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Title">
          {(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Guest can check out without an account" autoFocus />}
        </Field>
        {!editing && (
          <Field label="Key (optional)" hint={`Leave empty for the next ${projectKey}-REQ-n, or use your tracker's id (letters, digits, ".", "_", "-").`}>
            {(id) => <Input id={id} mono value={key} onChange={(e) => setKey(e.target.value)} placeholder={`${projectKey}-REQ-1`} autoComplete="off" />}
          </Field>
        )}
        <Field label="Description (optional)">
          {(id) => <Textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Acceptance criteria, links, notes" />}
        </Field>
        {/* Enter in a single-line field submits. */}
        <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
      </form>
      {error !== null && <Callout tone="danger">{error}</Callout>}
    </Dialog>
  );
}
