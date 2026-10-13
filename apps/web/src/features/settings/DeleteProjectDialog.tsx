import { useEffect, useState } from 'react';

import { Button, Dialog, Field, Input } from '@/components/ui';

/** Word the user must type to enable the delete button. */
export const DELETE_CONFIRM_WORD = 'delete';

interface DeleteProjectDialogProps {
  /** Project to delete; `null` closes the dialog. */
  project: { key: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (key: string) => void;
}

/** Confirms deleting a project: the delete button stays disabled until the user types "delete". */
export function DeleteProjectDialog({ project, onOpenChange, onConfirm }: DeleteProjectDialogProps) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (project === null) setTyped('');
  }, [project]);
  const ok = typed.trim().toLowerCase() === DELETE_CONFIRM_WORD;
  const confirm = () => {
    if (!ok || project === null) return;
    onConfirm(project.key);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={project !== null}
      onOpenChange={onOpenChange}
      title={`Delete project ${project?.key ?? ''}?`}
      description={
        <>
          Permanently deletes <span className="font-medium text-fg">{project?.name}</span> and everything in it: test cases, plans,
          runs, defects, environments and stored artifacts. This cannot be undone.
        </>
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger-outline" disabled={!ok} onClick={confirm}>
            Delete project
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <Field label={`Type "${DELETE_CONFIRM_WORD}" to confirm`}>
          {(id) => <Input id={id} mono autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
