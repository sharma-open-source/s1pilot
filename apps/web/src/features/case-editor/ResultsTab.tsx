import { Link } from '@tanstack/react-router';

import { Callout, EmptyState, Skeleton, StatusPill } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

const MAX_RUNS = 50;
const MAX_RESULTS = 20;

/**
 * Results tab: the last 20 results of this case. There is no per-case results endpoint yet, so it scans the
 * project's most recent runs (`runs.list` then `runs.get`) and keeps this case's results.
 */
export function ResultsTab({ projectKey, caseKey }: { projectKey: string; caseKey: string }) {
  const runs = trpc.runs.list.useQuery({ projectKey, limit: MAX_RUNS });
  const details = trpc.useQueries((t) => (runs.data ?? []).map((r) => t.runs.get(r.id)));

  if (runs.isPending) return <Skeleton className="h-40 w-full" />;
  if (runs.isError) return <Callout tone="danger">Could not load runs: {errorMessage(runs.error)}</Callout>;

  const loading = details.some((d) => d.isPending);
  const rows = details
    .flatMap((d) => (d.data ? d.data.results.filter((r) => r.key === caseKey).map((r) => ({ run: d.data, result: r })) : []))
    .slice(0, MAX_RESULTS);

  if (loading && rows.length === 0) return <Skeleton className="h-40 w-full" />;
  if (rows.length === 0) return <EmptyState>This case has not been run yet.</EmptyState>;

  return (
    <section aria-label="Results" className="flex flex-col gap-3">
      <div className="relative overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">Last results of {caseKey}</caption>
          <thead>
            <tr className="bg-surface-subtle text-left text-xs font-medium uppercase tracking-[0.05em] text-secondary">
              {['Run', 'Result', 'Version', 'Environment', 'Browser', 'Mode', 'Duration'].map((h) => (
                <th key={h} scope="col" className="px-3.5 py-2.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ run, result }) => (
              <tr key={result.id} className="border-t border-divider-row">
                <td className="px-3.5 py-3 font-mono">
                  <Link to={'/p/$key/runs/$runId' as never} params={{ key: projectKey, runId: run.id } as never} className="text-primary-text">
                    {run.id.slice(0, 8)}
                  </Link>
                </td>
                <td className="px-3.5 py-3">
                  <StatusPill status={result.verdict} />
                </td>
                <td className="px-3.5 py-3 font-mono">v{result.caseVersion}</td>
                <td className="px-3.5 py-3">{run.config?.environment ?? '—'}</td>
                <td className="px-3.5 py-3">{result.browser ?? run.config?.browser ?? '—'}</td>
                <td className="px-3.5 py-3">{result.mode}</td>
                <td className="px-3.5 py-3 font-mono">{(result.durationMs / 1000).toFixed(1)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <p className="m-0 text-xs text-secondary">Loading more runs…</p>}
    </section>
  );
}
