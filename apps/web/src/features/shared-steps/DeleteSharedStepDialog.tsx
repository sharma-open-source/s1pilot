import { usageLines, usageTotal, type SharedStepUsage } from './model';

import { Button, ConfirmDialog, Dialog } from '@/components/ui';

interface DeleteSharedStepDialogProps {
  /** The shared step to delete; `null` closes the dialog. */
  target: { name: string; usage: SharedStepUsage } | null;
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Confirms deleting an unused shared step. A shared step that is still used cannot be deleted: the dialog
 * lists where it is used instead.
 */
export function DeleteSharedStepDialog({ target, onClose, onConfirm }: DeleteSharedStepDialogProps) {
  const used = target !== null && usageTotal(target.usage) > 0;
  if (used) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={`“${target.name}” is still used`}
        description="Remove it from these places first, then delete it."
        footer={<Button onClick={onClose}>Close</Button>}
      >
        <UsageList usage={target.usage} />
      </Dialog>
    );
  }
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Delete “${target?.name ?? ''}”?`}
      description="No test case, shared step or login uses it. This cannot be undone."
      confirmLabel="Delete shared step"
      tone="danger"
      onConfirm={onConfirm}
    />
  );
}

/** Where a shared step is used, grouped by kind. */
export function UsageList({ usage }: { usage: SharedStepUsage }) {
  const lines = usageLines(usage);
  if (lines.length === 0) return <p className="m-0 text-sm text-secondary">Not used yet.</p>;
  return (
    <dl className="m-0 flex flex-col gap-2 text-sm">
      {lines.map((l) => (
        <div key={l.label}>
          <dt className="text-[13px] text-secondary">{l.label}</dt>
          <dd className="m-0 break-words font-mono text-[13px]">{l.items.join(', ')}</dd>
        </div>
      ))}
    </dl>
  );
}
