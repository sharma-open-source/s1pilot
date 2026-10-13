import type { ReactNode } from 'react';

import { KEY_HINT, type WizardDraft, type WizardStep } from './model';

import { Button } from '@/components/ui';

/** Props every wizard step receives from `ProjectWizard`. */
export interface StepProps {
  draft: WizardDraft;
  /** Shallow-merges into the draft and persists it to sessionStorage. */
  patch: (p: Partial<WizardDraft>) => void;
  /** Navigates to another step. */
  go: (step: WizardStep) => void;
  /** Leaves the wizard without finishing (first step's Back). */
  onExit: () => void;
  /** Leaves the wizard for an in-app path and clears the draft. */
  onFinish: (to: string) => void;
}

/** Inline field error for `Field`'s `hint` slot. */
export function fieldError(message: string | undefined): ReactNode {
  return message === undefined ? undefined : (
    <span role="alert" className="text-danger">
      {message}
    </span>
  );
}

/** Back (secondary) / Continue to <next> (ink) footer. The continue button submits the surrounding form. */
export function WizardFooter({
  onBack,
  continueLabel,
  pending = false,
  pendingLabel,
}: {
  onBack: () => void;
  continueLabel: string;
  pending?: boolean;
  pendingLabel?: string;
}) {
  return (
    <footer className="flex flex-wrap justify-between gap-3 border-t border-line pt-2">
      <Button variant="secondary" onClick={onBack} disabled={pending}>
        Back
      </Button>
      <Button variant="ink" type="submit" disabled={pending}>
        {pending ? (pendingLabel ?? 'Saving…') : continueLabel}
      </Button>
    </footer>
  );
}

/** Result line next to a long-running action: progress text, then success or danger text (design.md 6). */
export function ResultLine({
  state,
  progress,
  success,
  error,
}: {
  state: 'idle' | 'pending' | 'success' | 'error';
  progress: string;
  success?: string;
  error?: string;
}) {
  if (state === 'idle') return null;
  if (state === 'pending') {
    return (
      <span role="status" className="text-sm text-secondary">
        {progress}
      </span>
    );
  }
  if (state === 'success') {
    return (
      <span role="status" className="text-sm font-medium text-success">
        {success}
      </span>
    );
  }
  return (
    <span role="alert" className="text-sm font-medium text-danger">
      {error}
    </span>
  );
}

/**
 * Hint under an API key field. With a key saved (encrypted on the server) it says so and offers Remove / Keep;
 * the key itself is never sent back to the browser.
 */
export function KeyHint({ saved, removed, onToggleRemove, extra }: { saved: boolean; removed: boolean; onToggleRemove: () => void; extra?: string }) {
  if (!saved) return <>{extra !== undefined ? `${KEY_HINT} ${extra}` : KEY_HINT}</>;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1" role="status">
      <span className={removed ? 'text-warning' : 'text-success'}>
        {removed ? 'The saved key is removed when you save.' : 'Key saved (encrypted). Type a new key to replace it.'}
      </span>
      <Button size="sm" variant="secondary" onClick={onToggleRemove}>
        {removed ? 'Keep saved key' : 'Remove saved key'}
      </Button>
    </span>
  );
}
