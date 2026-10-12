import { ConfirmDialog } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

interface DeletePlanDialogProps {
  plan: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  /** Called with the deleted plan (plans list already invalidated). */
  onDeleted?: (plan: { id: string; name: string }) => void;
  onError: (message: string) => void;
}

/** Confirms and deletes a test plan (plans list and plan builder). Past runs are kept. */
export function DeletePlanDialog({ plan, onOpenChange, onDeleted, onError }: DeletePlanDialogProps) {
  const utils = trpc.useUtils();
  const del = trpc.plans.delete.useMutation({ onError: (err) => onError(errorMessage(err)) });
  return (
    <ConfirmDialog
      open={plan !== null}
      onOpenChange={onOpenChange}
      title={`Delete plan "${plan?.name ?? ''}"?`}
      description="Its schedule and webhook trigger stop. The test cases and past runs are kept; the runs are no longer linked to this plan. This cannot be undone."
      confirmLabel="Delete plan"
      tone="danger"
      onConfirm={() => {
        // The dialog closes (and `plan` is cleared) before the request finishes: keep the plan for the callback.
        if (plan === null) return;
        const deleted = plan;
        del.mutate(deleted.id, {
          onSuccess: () => {
            void utils.plans.list.invalidate();
            onDeleted?.(deleted);
          },
        });
      }}
    />
  );
}
