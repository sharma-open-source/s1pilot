import { keepPreviousData } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { runDuration, shortRunId } from './model';

import { PageHeader } from '@/components/app/PageHeader';
import { Button, Callout, DEFAULT_PAGE_SIZE, EmptyState, LinkButton, Pagination, pageCountOf, Skeleton, StatusPill } from '@/components/ui';
import { relativeTime } from '@/features/dashboard/model';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

const LIVE = ['queued', 'running', 'paused'];

/** URL search of the runs and reports lists (`?page=`, omitted on page 1). */
export interface RunsListSearch {
  page?: number;
}

export interface RunsListPageProps {
  projectKey: string;
  /** List finished runs only, with an Export column. */
  reports?: boolean;
  search?: RunsListSearch;
  onSearch?: (next: RunsListSearch) => void;
}

/**
 * Runs list (`/p/:key/runs`): one row per run with status and counts, linking to the report (or live view), paged on the server.
 * With `reports` (`/p/:key/reports`) it lists finished runs only, with an Export column (JUnit, HTML, JSON, PDF).
 */
export function RunsListPage({ projectKey, reports = false, search = {}, onSearch }: RunsListPageProps) {
  const page = search.page ?? 1;
  const query = trpc.runs.page.useQuery(
    { projectKey, finished: reports, page, pageSize: DEFAULT_PAGE_SIZE },
    { refetchInterval: 5000, placeholderData: keepPreviousData },
  );
  const base = `/p/${encodeURIComponent(projectKey)}/runs`;
  const runs = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const title = reports ? 'Reports' : 'Runs';
  const goTo = (p: number) => onSearch?.(p <= 1 ? {} : { page: p });

  return (
    <>
      <PageHeader title={title} />
      {query.isError && <Callout tone="danger">Could not load runs: {errorMessage(query.error)}</Callout>}
      {query.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : runs.length === 0 && !query.isError && page > 1 ? (
        <EmptyState action={<Button onClick={() => goTo(1)}>Go to first page</Button>}>This page is empty. The list may have changed.</EmptyState>
      ) : runs.length === 0 && !query.isError ? (
        <EmptyState action={<LinkButton to={`/p/${encodeURIComponent(projectKey)}/cases`}>Go to test cases</LinkButton>}>
          {reports ? 'No finished runs yet. Reports appear here once a run completes.' : 'No runs yet. Select test cases and choose Run to start one.'}
        </EmptyState>
      ) : (
        <div className="rounded-card border border-line bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <caption className="sr-only">{title}, newest first</caption>
              <thead className="bg-surface-subtle text-xs uppercase tracking-[0.05em] text-muted">
                <tr>
                  {['Run', 'Plan / cases', 'Env', 'Trigger', 'Status', 'Counts', 'Started', 'Duration', ...(reports ? ['Export'] : [])].map((h) => (
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
                      <td className="whitespace-nowrap px-3.5 py-3 font-mono text-xs text-secondary">{runDuration(r.startedAt, r.finishedAt) ?? (live ? 'running' : '–')}</td>
                      {reports && (
                        <td className="whitespace-nowrap px-3.5 py-3 text-xs">
                          {[
                            ['JUnit', `export/junit`],
                            ['HTML', `export/html`],
                            ['JSON', `export/json`],
                            ['PDF', `export.pdf`],
                          ].map(([label, path]) => (
                            <a key={label} href={`/api/runs/${encodeURIComponent(r.id)}/${path}`} className="mr-2 inline-flex min-h-[44px] items-center text-primary-text" download>
                              {label}
                            </a>
                          ))}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageCount={pageCountOf(total, DEFAULT_PAGE_SIZE)} shown={runs.length} total={total} onPageChange={goTo} />
        </div>
      )}
    </>
  );
}
