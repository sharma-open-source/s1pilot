import { Link } from '@tanstack/react-router';

import { shortRunId } from './model';

import { PageHeader } from '@/components/app/PageHeader';
import { Callout, EmptyState, LinkButton, Skeleton, StatusPill } from '@/components/ui';
import { relativeTime } from '@/features/dashboard/model';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

const LIVE = ['queued', 'running', 'paused'];

/** Runs list (`/p/:key/runs`): one row per run with status and counts, linking to the report (or live view). */
export function RunsListPage({ projectKey }: { projectKey: string }) {
  const query = trpc.runs.list.useQuery({ projectKey }, { refetchInterval: 5000 });
  const base = `/p/${encodeURIComponent(projectKey)}/runs`;
  const runs = query.data ?? [];

  return (
    <>
      <PageHeader title="Runs" />
      {query.isError && <Callout tone="danger">Could not load runs: {errorMessage(query.error)}</Callout>}
      {query.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : runs.length === 0 && !query.isError ? (
        <EmptyState action={<LinkButton to={`/p/${encodeURIComponent(projectKey)}/cases`}>Go to test cases</LinkButton>}>
          No runs yet. Select test cases and choose Run to start one.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <caption className="sr-only">Runs, newest first</caption>
            <thead className="bg-surface-subtle text-xs uppercase tracking-[0.05em] text-muted">
              <tr>
                {['Run', 'Plan / cases', 'Env', 'Trigger', 'Status', 'Counts', 'Started'].map((h) => (
                  <th key={h} scope="col" className="px-3.5 py-2.5 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const live = LIVE.includes(r.status);
                const s = r.summary;
                return (
                  <tr key={r.id} className="border-t border-divider-row align-middle">
                    <td className="px-3.5 py-3">
                      <Link
                        to={`${base}/${encodeURIComponent(r.id)}${live ? '/live' : ''}` as never}
                        className="inline-flex min-h-[44px] items-center font-mono text-primary-text"
                      >
                        #{shortRunId(r.id)}
                      </Link>
                      {r.buildRef && <div className="font-mono text-xs text-muted">{r.buildRef}</div>}
                    </td>
                    <td className="px-3.5 py-3">{r.planId ? 'Plan' : 'Ad-hoc'} · {r.progress.total} {r.progress.total === 1 ? 'case' : 'cases'}</td>
                    <td className="px-3.5 py-3 font-mono text-xs">{r.config?.environment ?? '–'}</td>
                    <td className="px-3.5 py-3">{r.trigger}</td>
                    <td className="px-3.5 py-3">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="whitespace-nowrap px-3.5 py-3 font-mono text-xs">
                      <span className="text-success">{s.passed} passed</span> · <span className="text-danger">{s.failed + s.blocked} failed</span> ·{' '}
                      <span className="text-warning">{s.needsReview} review</span>
                    </td>
                    <td className="whitespace-nowrap px-3.5 py-3 text-secondary">
                      <time dateTime={r.startedAt}>{relativeTime(r.startedAt)}</time>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
