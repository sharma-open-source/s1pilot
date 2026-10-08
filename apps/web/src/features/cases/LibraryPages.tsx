import type { ReactNode } from 'react';

import { PageHeader } from '@/components/app/PageHeader';
import { Breadcrumb, Callout, Card, EmptyState, LinkButton, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  mono?: boolean;
}

interface LibraryTableProps<T> {
  title: string;
  projectKey: string;
  rows: T[] | undefined;
  loading: boolean;
  error: unknown;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  empty: ReactNode;
}

function LibraryTable<T>({ title, projectKey, rows, loading, error, columns, rowKey, empty }: LibraryTableProps<T>) {
  return (
    <>
      <PageHeader
        eyebrow={
          <Breadcrumb
            items={[{ label: 'Test cases', to: `/p/${encodeURIComponent(projectKey)}/cases` }, { label: 'Library' }, { label: title }]}
          />
        }
        title={title}
        actions={
          <LinkButton to={`/p/${encodeURIComponent(projectKey)}/cases`} variant="secondary">
            Back to test cases
          </LinkButton>
        }
      />
      <Card aria-label={title}>
        {error !== undefined && error !== null && (
          <div className="p-4">
            <Callout tone="danger">{errorMessage(error)}</Callout>
          </div>
        )}
        {loading && (
          <div className="flex flex-col gap-2 p-4" aria-label={`Loading ${title}`}>
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        )}
        {rows !== undefined && rows.length === 0 && (
          <div className="p-4">
            <EmptyState>{empty}</EmptyState>
          </div>
        )}
        {rows !== undefined && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-[0.05em] text-muted">
                  {columns.map((c, i) => (
                    <th key={c.header} scope="col" className={i === 0 || i === columns.length - 1 ? 'px-4 py-2.5 font-medium' : 'px-2 py-2.5 font-medium'}>
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={rowKey(row)} className="border-t border-divider-row">
                    {columns.map((c, i) => (
                      <td
                        key={c.header}
                        className={`${i === 0 || i === columns.length - 1 ? 'px-4' : 'px-2'} py-3 ${c.mono === true ? 'font-mono text-[13px]' : ''}`}
                      >
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/** Library: shared steps and flows with parameters, step count and usage. */
export function SharedStepsPage({ projectKey }: { projectKey: string }) {
  const q = trpc.sharedSteps.list.useQuery({ projectKey });
  return (
    <LibraryTable
      title="Shared steps & flows"
      projectKey={projectKey}
      rows={q.data}
      loading={q.isLoading}
      error={q.error}
      rowKey={(r) => r.id}
      empty="No shared steps yet. Flows you extract from test cases appear here."
      columns={[
        { header: 'Name', cell: (r) => <span className="font-medium">{r.name}</span> },
        { header: 'Parameters', mono: true, cell: (r) => (r.params.length > 0 ? r.params.map((p) => `{${p}}`).join(' ') : '—') },
        { header: 'Steps', cell: (r) => r.steps.length },
        { header: 'Used by', cell: (r) => `${r.usageCount} case${r.usageCount === 1 ? '' : 's'}` },
      ]}
    />
  );
}

/** Library: requirements and the cases that cover them. */
export function RequirementsPage({ projectKey }: { projectKey: string }) {
  const q = trpc.requirements.list.useQuery({ projectKey });
  return (
    <LibraryTable
      title="Requirements"
      projectKey={projectKey}
      rows={q.data}
      loading={q.isLoading}
      error={q.error}
      rowKey={(r) => r.id}
      empty="No requirements yet. Link a test case to a requirement to track coverage."
      columns={[
        { header: 'Key', mono: true, cell: (r) => r.key },
        { header: 'Title', cell: (r) => <span className="font-medium">{r.title}</span> },
        { header: 'Covered by', mono: true, cell: (r) => (r.caseKeys.length > 0 ? r.caseKeys.join(', ') : <span className="font-sans text-muted">Not covered</span>) },
        { header: 'Coverage', cell: (r) => `${r.coverage} case${r.coverage === 1 ? '' : 's'}` },
      ]}
    />
  );
}

/** Library: test data sets. They are defined per environment, so this page points there. */
export function TestDataPage({ projectKey }: { projectKey: string }) {
  return (
    <LibraryTable
      title="Test data sets"
      projectKey={projectKey}
      rows={[]}
      loading={false}
      error={undefined}
      rowKey={() => 'none'}
      columns={[{ header: 'Name', cell: () => null }]}
      empty={
        <>
          Test data sets are defined per environment. Open{' '}
          <a className="text-primary-text" href={`/p/${encodeURIComponent(projectKey)}/environments`}>
            Environments
          </a>{' '}
          to manage them.
        </>
      }
    />
  );
}
