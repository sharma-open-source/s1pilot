import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { DeleteSharedStepDialog } from './DeleteSharedStepDialog';
import type { SharedStepRow } from './model';

import { PageHeader } from '@/components/app/PageHeader';
import { Breadcrumb, Button, Callout, Card, EmptyState, Input, LinkButton, Pagination, paginate, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { Can } from '@/lib/session';
import { trpc } from '@/lib/trpc';

type Notice = { tone: 'success' | 'danger'; text: string };

/** "Used by" cell: case count plus other flows / logins. */
function UsedBy({ row }: { row: SharedStepRow }) {
  const parts = [
    row.usageCount > 0 ? `${row.usageCount} case${row.usageCount === 1 ? '' : 's'}` : '',
    row.usage.flows.length > 0 ? `${row.usage.flows.length} shared step${row.usage.flows.length === 1 ? '' : 's'}` : '',
    row.usage.logins.length > 0 ? `${row.usage.logins.length} login${row.usage.logins.length === 1 ? '' : 's'}` : '',
  ].filter((p) => p !== '');
  return parts.length > 0 ? <span>{parts.join(' · ')}</span> : <span className="text-muted">Not used</span>;
}

/**
 * Library: shared steps and flows (`/p/:key/library/shared-steps`). Lists reusable step sequences with their
 * parameters and usage; create, edit and delete them.
 */
export function SharedStepsPage({ projectKey }: { projectKey: string }) {
  const utils = trpc.useUtils();
  const q = trpc.sharedSteps.list.useQuery({ projectKey });
  const del = trpc.sharedSteps.delete.useMutation();
  const [filter, setFilter] = useState('');
  const [pageNo, setPageNo] = useState(1);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [deleting, setDeleting] = useState<SharedStepRow | null>(null);

  const rows = q.data;
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (rows === undefined || f === '') return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(f) || r.steps.some((s) => s.action.toLowerCase().includes(f)));
  }, [rows, filter]);
  const paged = paginate(shown ?? [], pageNo);
  const base = `/p/${encodeURIComponent(projectKey)}`;
  const editHref = (id: string) => `${base}/library/shared-steps/${encodeURIComponent(id)}`;

  return (
    <>
      <PageHeader
        eyebrow={<Breadcrumb items={[{ label: 'Test cases', to: `${base}/cases` }, { label: 'Library' }, { label: 'Shared steps & flows' }]} />}
        title="Shared steps & flows"
        actions={
          <>
            <LinkButton to={`${base}/cases`} variant="secondary">
              Back to test cases
            </LinkButton>
            <Can permission="content:write">
              <LinkButton to={editHref('new')} variant="primary">
                New shared step
              </LinkButton>
            </Can>
          </>
        }
      />
      {notice !== null && (
        <div role="status">
          <Callout tone={notice.tone}>{notice.text}</Callout>
        </div>
      )}
      <Card aria-label="Shared steps & flows">
        {rows !== undefined && rows.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-divider px-4 py-3">
            <label className="flex min-w-0 flex-[1_1_260px] items-center gap-2 text-[13px]">
              <span className="text-secondary">Filter</span>
              <Input className="h-[36px] flex-1" value={filter} onChange={(e) => {
                  setFilter(e.target.value);
                  setPageNo(1);
                }} placeholder="Name or step text" />
            </label>
            <span className="text-[13px] text-secondary">
              {rows.length} shared step{rows.length === 1 ? '' : 's'}
            </span>
          </div>
        )}
        {q.error !== null && (
          <div className="p-4">
            <Callout tone="danger">{errorMessage(q.error)}</Callout>
          </div>
        )}
        {q.isLoading && (
          <div className="flex flex-col gap-2 p-4" aria-label="Loading shared steps">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        )}
        {rows !== undefined && rows.length === 0 && (
          <div className="p-4">
            <EmptyState
              action={
                <LinkButton to={editHref('new')} variant="secondary">
                  New shared step
                </LinkButton>
              }
            >
              No shared steps yet. A shared step is a sequence of steps, such as “Log in as {'{role}'}”, that many test cases run.
              Create one here, or use “Save steps as shared step” in a test case.
            </EmptyState>
          </div>
        )}
        {shown !== undefined && shown.length === 0 && rows !== undefined && rows.length > 0 && (
          <p className="m-0 p-4 text-sm text-secondary">No shared step matches “{filter.trim()}”.</p>
        )}
        {shown !== undefined && shown.length > 0 && (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <caption className="sr-only">Shared steps & flows</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-[0.05em] text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Parameters</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Steps</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Used by</th>
                  <th scope="col" className="px-4 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map((r) => (
                  <tr key={r.id} className="border-t border-divider-row align-top">
                    <td className="max-w-[320px] px-4 py-3">
                      <Link to={editHref(r.id) as never} className="font-medium text-primary-text">
                        {r.name}
                      </Link>
                      <div className="mt-0.5 line-clamp-2 text-[13px] text-secondary">{r.steps.map((s) => s.action).join(' → ')}</div>
                    </td>
                    <td className="px-2 py-3 font-mono text-[13px]">{r.params.length > 0 ? r.params.map((p) => `{${p}}`).join(' ') : '—'}</td>
                    <td className="px-2 py-3">{r.steps.length}</td>
                    <td className="whitespace-nowrap px-2 py-3">
                      <UsedBy row={r} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2 whitespace-nowrap">
                        <LinkButton size="sm" to={editHref(r.id)} aria-label={`Edit ${r.name}`}>
                          Edit
                        </LinkButton>
                        <Button size="sm" variant="danger-outline" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {shown !== undefined && shown.length > 0 && (
          <Pagination page={paged.page} pageCount={paged.pageCount} shown={paged.items.length} total={paged.total} onPageChange={setPageNo} />
        )}
      </Card>

      <DeleteSharedStepDialog
        target={deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const r = deleting;
          if (r === null) return;
          del.mutate(
            { id: r.id },
            {
              onSuccess: () => {
                void utils.sharedSteps.list.invalidate();
                setNotice({ tone: 'success', text: `Deleted “${r.name}”` });
              },
              onError: (e) => setNotice({ tone: 'danger', text: errorMessage(e) }),
            },
          );
        }}
      />
    </>
  );
}
