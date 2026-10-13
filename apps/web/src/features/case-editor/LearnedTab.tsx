import { useState } from 'react';

import { Button, Callout, Card, ConfirmDialog, EmptyState, Pill, type PillTone } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { Can } from '@/lib/session';
import { trpc, type RouterOutputs } from '@/lib/trpc';

export type LearnedInfo = RouterOutputs['cases']['get']['learned'][number];

/** Label and tone of one environment's learned script ("Ready · 4/4 steps", "Not learned"). */
export function learnedSummary(l: LearnedInfo, stepCount: number): { label: string; tone: PillTone | 'plain' } {
  switch (l.status) {
    case 'current':
      return { label: `Ready · ${stepCount}/${stepCount} steps`, tone: 'success' };
    case 'stale':
      return { label: `Out of date · learned on v${l.caseVersion ?? '?'}`, tone: 'warning' };
    case 'needs-review':
      return { label: `Healed · ${l.pendingProposals ?? 0} to approve`, tone: 'warning' };
    default:
      return { label: 'Not learned', tone: 'plain' };
  }
}

/** "Learned script" tab: per-environment state of the replayable script, with "Forget script" (confirmed). */
export function LearnedTab({ caseKey, learned, stepCount }: { caseKey: string; learned: LearnedInfo[]; stepCount: number }) {
  const utils = trpc.useUtils();
  const forget = trpc.cases.forgetLearned.useMutation();
  const [confirming, setConfirming] = useState<LearnedInfo | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const forgetScript = (l: LearnedInfo): void => {
    setNotice(null);
    forget.mutate(
      { key: caseKey, environmentId: l.environmentId },
      {
        onSuccess: () => {
          void utils.cases.get.invalidate();
          void utils.cases.list.invalidate();
          setNotice({ tone: 'success', text: `Learned script for ${l.environmentName} forgotten. The next run there explores again.` });
        },
        onError: (err) => setNotice({ tone: 'danger', text: errorMessage(err) }),
      },
    );
  };

  return (
    <section aria-label="Learned script" className="flex flex-col gap-4">
      <p className="m-0 max-w-[70ch] text-sm text-secondary">Next run replays without model calls; S1 heals only changed steps.</p>
      {notice !== null && (
        <div role={notice.tone === 'danger' ? 'alert' : 'status'}>
          <Callout tone={notice.tone}>{notice.text}</Callout>
        </div>
      )}
      {learned.length === 0 && <EmptyState>This project has no environments yet, so nothing can be learned.</EmptyState>}
      {learned.map((l) => {
        const s = learnedSummary(l, stepCount);
        const nothing = l.status === 'none';
        return (
          <Card key={l.environmentId} aria-label={`Learned script for ${l.environmentName}`} className="flex flex-col gap-3 p-[18px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-fg">{l.environmentName}</h2>
              {s.tone === 'plain' ? <span className="text-sm text-secondary">{s.label}</span> : <Pill tone={s.tone}>{s.label}</Pill>}
            </div>
            {!nothing && (
              <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
                <dt className="text-secondary">Learned on version</dt>
                <dd className="m-0 font-mono">v{l.caseVersion}</dd>
                <dt className="text-secondary">Heals so far</dt>
                <dd className="m-0 font-mono">{l.healCount ?? 0}</dd>
                <dt className="text-secondary">Proposals to approve</dt>
                <dd className="m-0 font-mono">{l.pendingProposals ?? 0}</dd>
                <dt className="text-secondary">Last replayed</dt>
                <dd className="m-0 font-mono">{l.lastReplayedAt ?? 'never'}</dd>
              </dl>
            )}
            <Can permission="content:write">
              <div>
                <Button
                  variant="danger-outline"
                  disabled={nothing || forget.isPending}
                  title={nothing ? `Nothing learned in ${l.environmentName} yet` : undefined}
                  onClick={() => setConfirming(l)}
                >
                  Forget script
                </Button>
              </div>
            </Can>
          </Card>
        );
      })}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={`Forget the learned script for ${confirming?.environmentName ?? ''}?`}
        description="The next run in this environment explores with the model again and learns a new script. Pending heal proposals for it will no longer change anything. This cannot be undone."
        confirmLabel="Forget script"
        tone="danger"
        onConfirm={() => {
          if (confirming !== null) forgetScript(confirming);
        }}
      />
      <Callout tone="info-ai">Resolved actions (locator, action, value reference) need a learned-script API that the server does not offer yet.</Callout>
    </section>
  );
}
