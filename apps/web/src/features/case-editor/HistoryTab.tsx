import type { Step } from '@s1pilot/domain';
import { useState } from 'react';

import { stepLines } from './model';

import { Callout, EmptyState, Field, Select, Skeleton, Tag } from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

function StepCell({ step }: { step: Step | undefined }) {
  if (!step) return <span className="text-muted">—</span>;
  return (
    <div className="flex flex-col gap-1">
      <span>{step.action}</span>
      {step.expected !== undefined && step.expected !== '' && <span className="text-secondary">Expected: {step.expected}</span>}
      {stepLines([{ ...step, action: '', expected: undefined }])
        .slice(1)
        .map((l) => (
          <span key={l} className="font-mono text-xs text-secondary">
            {l.trim()}
          </span>
        ))}
    </div>
  );
}

const CHANGE_TONE = { added: 'primary', removed: 'danger', changed: 'warning', unchanged: 'neutral' } as const;

/** History tab: stored versions and a side-by-side step diff between two of them. */
export function HistoryTab({ caseKey }: { caseKey: string }) {
  const history = trpc.cases.history.useQuery({ key: caseKey });
  const versions = (history.data ?? []).map((h) => h.version).sort((a, b) => b - a);
  const [fromPick, setFromPick] = useState<number | undefined>();
  const [toPick, setToPick] = useState<number | undefined>();
  const to = toPick ?? versions[0];
  const from = fromPick ?? versions[1];
  const diff = trpc.cases.diff.useQuery(
    { key: caseKey, fromVersion: from ?? 1, toVersion: to ?? 1 },
    { enabled: from !== undefined && to !== undefined },
  );

  if (history.isPending) return <Skeleton className="h-40 w-full" />;
  if (history.isError) return <Callout tone="danger">Could not load history: {errorMessage(history.error)}</Callout>;

  return (
    <section aria-label="History" className="flex flex-col gap-4">
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm" aria-label="Versions">
        {history.data
          .slice()
          .sort((a, b) => b.version - a.version)
          .map((h) => (
            <li key={h.version} className="flex flex-wrap items-center gap-3 rounded-control border border-line bg-surface px-3 py-2">
              <span className="font-mono font-semibold">v{h.version}</span>
              <span className="text-secondary">{h.title}</span>
              <span className="text-secondary">
                {h.steps.length} {h.steps.length === 1 ? 'step' : 'steps'}
              </span>
              {h.updatedAt !== undefined && <span className="ml-auto font-mono text-xs text-secondary">{h.updatedAt}</span>}
            </li>
          ))}
      </ol>
      {versions.length < 2 ? (
        <EmptyState>Only one version so far. Save changes to compare versions.</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <Field label="From version">
              {(id) => (
                <Select id={id} value={from} onChange={(e) => setFromPick(Number(e.target.value))} className="w-40">
                  {versions.map((v) => (
                    <option key={v} value={v}>
                      v{v}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="To version">
              {(id) => (
                <Select id={id} value={to} onChange={(e) => setToPick(Number(e.target.value))} className="w-40">
                  {versions.map((v) => (
                    <option key={v} value={v}>
                      v{v}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {diff.isPending && <Skeleton className="h-32 w-full" />}
          {diff.isError && <Callout tone="danger">Could not load the diff: {errorMessage(diff.error)}</Callout>}
          {diff.isSuccess && (
            <div className="relative overflow-x-auto rounded-card border border-line bg-surface">
              <table className="w-full min-w-[640px] border-collapse text-sm">
                <caption className="sr-only">
                  Step diff v{diff.data.fromVersion} to v{diff.data.toVersion}
                </caption>
                <thead>
                  <tr className="bg-surface-subtle text-left text-xs font-medium uppercase tracking-[0.05em] text-secondary">
                    <th scope="col" className="w-10 px-3.5 py-2.5 font-medium">
                      #
                    </th>
                    <th scope="col" className="px-2.5 py-2.5 font-medium">
                      v{diff.data.fromVersion}
                    </th>
                    <th scope="col" className="px-2.5 py-2.5 font-medium">
                      v{diff.data.toVersion}
                    </th>
                    <th scope="col" className="w-24 px-2.5 py-2.5 font-medium">
                      Change
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {diff.data.steps.map((s) => (
                    <tr key={s.index} className={cn('border-t border-divider-row align-top', s.change === 'unchanged' && 'text-secondary')}>
                      <td className="px-3.5 py-3 font-mono text-secondary">{s.index + 1}</td>
                      <td className={cn('px-2.5 py-3', (s.change === 'removed' || s.change === 'changed') && 'bg-danger-soft')}>
                        <StepCell step={s.before as Step | undefined} />
                      </td>
                      <td className={cn('px-2.5 py-3', (s.change === 'added' || s.change === 'changed') && 'bg-success-soft')}>
                        <StepCell step={s.after as Step | undefined} />
                      </td>
                      <td className="px-2.5 py-3">
                        <Tag tone={CHANGE_TONE[s.change]}>{s.change}</Tag>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
