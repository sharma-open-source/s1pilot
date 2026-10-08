import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

import { Button } from './button';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  /** Footer buttons (secondary + primary). */
  footer?: ReactNode;
}

/** Modal built on Radix Dialog with Card styling. */
export function Dialog({ open, onOpenChange, title, description, children, footer }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-ink opacity-40" />
        <RadixDialog.Content className="fixed left-1/2 top-1/2 flex max-h-[90vh] w-[calc(100vw-32px)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-auto rounded-card border border-line bg-surface p-5">
          <RadixDialog.Title className="text-lg font-semibold text-fg">{title}</RadixDialog.Title>
          {description !== undefined ? (
            <RadixDialog.Description className="m-0 text-sm text-secondary">{description}</RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
          )}
          {children}
          {footer !== undefined && <div className="flex flex-wrap justify-end gap-2">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** State the consequence of the action. */
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` for destructive actions (Abort run, Reject, Delete). */
  tone?: 'default' | 'danger';
  onConfirm: () => void;
}

/** Confirm variant of `Dialog`: secondary Cancel + primary (or danger-outline) confirm. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger-outline' : 'primary'}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
