import { Button, Callout, Card, EmptyState, Pill, type PillTone } from '@/components/ui';
import type { RouterOutputs } from '@/lib/trpc';

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

/** "Learned script" tab: per-environment state of the replayable script. */
export function LearnedTab({ learned, stepCount }: { learned: LearnedInfo[]; stepCount: number }) {
  return (
    <section aria-label="Learned script" className="flex flex-col gap-4">
      <p className="m-0 max-w-[70ch] text-sm text-secondary">Next run replays without model calls; S1 heals only changed steps.</p>
      {learned.length === 0 && <EmptyState>This project has no environments yet, so nothing can be learned.</EmptyState>}
      {learned.map((l) => {
        const s = learnedSummary(l, stepCount);
        return (
          <Card key={l.environmentId} aria-label={`Learned script for ${l.environmentName}`} className="flex flex-col gap-3 p-[18px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-fg">{l.environmentName}</h2>
              {s.tone === 'plain' ? <span className="text-sm text-secondary">{s.label}</span> : <Pill tone={s.tone}>{s.label}</Pill>}
            </div>
            {l.status !== 'none' && (
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
            <div>
              <Button variant="danger-outline" disabled title="The server does not expose learned scripts for removal yet">
                Forget script
              </Button>
            </div>
          </Card>
        );
      })}
      <Callout tone="info-ai">
        Resolved actions (locator, action, value reference) and forgetting a script need a learned-script API that the server does not offer yet.
      </Callout>
    </section>
  );
}
