import { diffLines, stepLines, type DraftStep } from './model';

import { Button, Dialog } from '@/components/ui';
import { cn } from '@/lib/cn';

interface ConflictDialogProps {
  open: boolean;
  /** Version stored on the server now. */
  serverVersion: number;
  /** Version the edits are based on. */
  baseVersion: number;
  serverSteps: Array<Pick<DraftStep, 'action' | 'expected' | 'assert' | 'inputs'>>;
  draftSteps: Array<Pick<DraftStep, 'action' | 'expected' | 'assert' | 'inputs'>>;
  busy: boolean;
  onReload: () => void;
  onOverwrite: () => void;
  onCancel: () => void;
}

/** Shown when a save is rejected because someone else saved a newer version. */
export function ConflictDialog({ open, serverVersion, baseVersion, serverSteps, draftSteps, busy, onReload, onOverwrite, onCancel }: ConflictDialogProps) {
  const lines = diffLines(stepLines(serverSteps), stepLines(draftSteps));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
      title="This case was changed elsewhere"
      description={`You edited v${baseVersion}, but the saved case is now v${serverVersion}. Reload to take the saved version (your edits are discarded), or overwrite it with your edits.`}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Keep editing
          </Button>
          <Button variant="secondary" disabled={busy} onClick={onReload}>
            Reload
          </Button>
          <Button variant="danger-outline" disabled={busy} onClick={onOverwrite}>
            {busy ? 'Saving…' : 'Overwrite'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <div className="text-xs text-secondary">
          Steps: saved v{serverVersion} compared with your edits
        </div>
        <pre
          aria-label="Differences"
          className="m-0 max-h-64 overflow-auto rounded-control border border-line bg-surface-subtle p-2.5 font-mono text-xs leading-5"
        >
          {lines.map((l, i) => (
            <div
              key={i}
              data-diff={l.kind}
              className={cn('whitespace-pre-wrap', l.kind === 'add' && 'bg-success-soft', l.kind === 'remove' && 'bg-danger-soft')}
            >
              {l.kind === 'add' ? '+ ' : l.kind === 'remove' ? '- ' : '  '}
              {l.text}
            </div>
          ))}
        </pre>
      </div>
    </Dialog>
  );
}
