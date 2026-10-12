import { Link } from '@tanstack/react-router';

import { Button, Callout, Dialog, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

interface SharedStepPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectKey: string;
  onPick: (step: { id: string; name: string; params: string[] }) => void;
  /** Shared step left out of the list (the one being edited: it cannot include itself). */
  excludeId?: string;
}

/** Dialog listing the project's shared steps with their usage counts. */
export function SharedStepPicker({ open, onOpenChange, projectKey, onPick, excludeId }: SharedStepPickerProps) {
  const list = trpc.sharedSteps.list.useQuery({ projectKey }, { enabled: open });
  const items = (list.data ?? []).filter((s) => s.id !== excludeId);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Insert shared step"
      description="Shared steps run the same sequence in every case that uses them."
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
      }
    >
      {list.isPending && <Skeleton className="h-16 w-full" />}
      {list.isError && <Callout tone="danger">Could not load shared steps: {errorMessage(list.error)}</Callout>}
      {list.isSuccess && items.length === 0 && (
        <p className="m-0 text-sm text-secondary">
          No {excludeId !== undefined ? 'other ' : ''}shared steps yet. Create one under{' '}
          <Link to={`/p/${encodeURIComponent(projectKey)}/library/shared-steps` as never} className="text-primary-text">
            Library, Shared steps & flows
          </Link>
          {excludeId === undefined ? ', or use “Save steps as shared step” below the steps.' : '.'}
        </p>
      )}
      {list.isSuccess && items.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => {
                  onPick({ id: s.id, name: s.name, params: s.params });
                  onOpenChange(false);
                }}
                className="flex min-h-[44px] w-full flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-surface px-3 py-2 text-left text-sm text-fg"
              >
                <span className="font-medium">{s.name}</span>
                <span className="text-xs text-secondary">
                  {s.steps.length} {s.steps.length === 1 ? 'step' : 'steps'} · used in {s.usageCount} {s.usageCount === 1 ? 'case' : 'cases'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
