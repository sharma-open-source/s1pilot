import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { CasePickerDialog } from '../plans/CasePickerDialog';

import { RequirementDialog, type RequirementRow } from './RequirementDialog';

import { PageHeader } from '@/components/app/PageHeader';
import { Breadcrumb, Button, Callout, Card, ConfirmDialog, EmptyState, Input, LinkButton, Pill, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { Can } from '@/lib/session';
import { trpc } from '@/lib/trpc';

/** Covering case keys shown in a row before "+n more". */
const MAX_KEYS = 6;

type Notice = { tone: 'success' | 'danger'; text: string };

/** Case keys of a row as links to the case editor. */
function CoveredBy({ projectKey, keys }: { projectKey: string; keys: string[] }) {
  if (keys.length === 0) return <span className="text-muted">Not covered</span>;
  const shown = keys.slice(0, MAX_KEYS);
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-[13px]">
      {shown.map((k) => (
        <Link key={k} to={`/p/${encodeURIComponent(projectKey)}/cases/${encodeURIComponent(k)}` as never} className="text-primary-text">
          {k}
        </Link>
      ))}
      {keys.length > shown.length && <span className="font-sans text-secondary">+{keys.length - shown.length} more</span>}
    </span>
  );
}

/**
 * Library: requirements (`/p/:key/library/requirements`). Create, edit and delete requirements, pick the
 * test cases that cover each one, and see uncovered requirements at a glance.
 */
export function RequirementsPage({ projectKey }: { projectKey: string }) {
  const utils = trpc.useUtils();
  const q = trpc.requirements.list.useQuery({ projectKey });
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; row: RequirementRow } | null>(null);
  const [linking, setLinking] = useState<RequirementRow | null>(null);
  const [deleting, setDeleting] = useState<RequirementRow | null>(null);

  const refresh = () => Promise.all([utils.requirements.list.invalidate(), utils.cases.invalidate()]);
  const setCases = trpc.requirements.setCases.useMutation({ onError: (e) => setNotice({ tone: 'danger', text: errorMessage(e) }) });
  const del = trpc.requirements.delete.useMutation({ onError: (e) => setNotice({ tone: 'danger', text: errorMessage(e) }) });

  const rows = q.data;
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (rows === undefined || f === '') return rows;
    return rows.filter((r) => r.key.toLowerCase().includes(f) || r.title.toLowerCase().includes(f) || (r.description ?? '').toLowerCase().includes(f));
  }, [rows, filter]);
  const uncovered = rows?.filter((r) => r.coverage === 0).length ?? 0;
  const base = `/p/${encodeURIComponent(projectKey)}/cases`;

  return (
    <>
      <PageHeader
        eyebrow={<Breadcrumb items={[{ label: 'Test cases', to: base }, { label: 'Library' }, { label: 'Requirements' }]} />}
        title="Requirements"
        actions={
          <>
            <LinkButton to={base} variant="secondary">
              Back to test cases
            </LinkButton>
            <Can permission="content:write">
              <Button variant="primary" onClick={() => setDialog({ mode: 'create' })}>
                New requirement
              </Button>
            </Can>
          </>
        }
      />
      {notice !== null && (
        <div role="status">
          <Callout tone={notice.tone}>{notice.text}</Callout>
        </div>
      )}
      <Card aria-label="Requirements">
        {rows !== undefined && rows.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-divider px-4 py-3">
            <label className="flex min-w-0 flex-[1_1_260px] items-center gap-2 text-[13px]">
              <span className="text-secondary">Filter</span>
              <Input className="h-[36px] flex-1" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Key, title or description" />
            </label>
            <span className="text-[13px] text-secondary">
              {rows.length} requirement{rows.length === 1 ? '' : 's'}
              {uncovered > 0 ? ` · ${uncovered} not covered` : ' · all covered'}
            </span>
          </div>
        )}
        {q.error !== null && (
          <div className="p-4">
            <Callout tone="danger">{errorMessage(q.error)}</Callout>
          </div>
        )}
        {q.isLoading && (
          <div className="flex flex-col gap-2 p-4" aria-label="Loading requirements">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        )}
        {rows !== undefined && rows.length === 0 && (
          <div className="p-4">
            <EmptyState action={<Button onClick={() => setDialog({ mode: 'create' })}>New requirement</Button>}>
              No requirements yet. Add one, then link the test cases that cover it to track coverage.
            </EmptyState>
          </div>
        )}
        {shown !== undefined && shown.length === 0 && rows !== undefined && rows.length > 0 && (
          <p className="m-0 p-4 text-sm text-secondary">No requirement matches “{filter.trim()}”.</p>
        )}
        {shown !== undefined && shown.length > 0 && (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-sm">
              <caption className="sr-only">Requirements</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-[0.05em] text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">Key</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Title</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Covered by</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Coverage</th>
                  <th scope="col" className="px-4 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className="border-t border-divider-row align-top">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[13px]">{r.key}</td>
                    <td className="max-w-[360px] px-2 py-3">
                      <div className="font-medium">{r.title}</div>
                      {r.description !== undefined && <div className="mt-0.5 line-clamp-2 whitespace-pre-line text-[13px] text-secondary">{r.description}</div>}
                    </td>
                    <td className="px-2 py-3">
                      <CoveredBy projectKey={projectKey} keys={r.caseKeys} />
                    </td>
                    <td className="whitespace-nowrap px-2 py-3">
                      {r.coverage === 0 ? <Pill tone="warning">Not covered</Pill> : `${r.coverage} case${r.coverage === 1 ? '' : 's'}`}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2 whitespace-nowrap">
                        <Button size="sm" aria-label={`Link cases to ${r.key}`} onClick={() => setLinking(r)}>
                          Link cases
                        </Button>
                        <Button size="sm" aria-label={`Edit ${r.key}`} onClick={() => setDialog({ mode: 'edit', row: r })}>
                          Edit
                        </Button>
                        <Button size="sm" variant="danger-outline" aria-label={`Delete ${r.key}`} onClick={() => setDeleting(r)}>
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
      </Card>

      <RequirementDialog
        projectKey={projectKey}
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        {...(dialog?.mode === 'edit' ? { editing: dialog.row } : {})}
        onSaved={(key) => setNotice({ tone: 'success', text: dialog?.mode === 'edit' ? `Saved ${key}` : `Created ${key}. Use Link cases to add the test cases that cover it.` })}
      />
      <CasePickerDialog
        projectKey={projectKey}
        open={linking !== null}
        onOpenChange={(open) => {
          if (!open) setLinking(null);
        }}
        initial={linking?.coveringCaseIds ?? []}
        description={linking ? `Tick the test cases that cover ${linking.key} · ${linking.title}.` : ''}
        confirmLabel={(n) => `Link ${n} case${n === 1 ? '' : 's'}`}
        onConfirm={(caseIds) => {
          const r = linking;
          if (r === null) return;
          setCases.mutate(
            { projectKey, key: r.key, caseIds },
            {
              onSuccess: (out) => {
                void refresh();
                setNotice({ tone: 'success', text: `${r.key}: ${out.added} linked, ${out.removed} unlinked` });
              },
            },
          );
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${deleting?.key ?? ''}?`}
        description={
          deleting !== null && deleting.coverage > 0
            ? `It is removed from the ${deleting.coverage} test case${deleting.coverage === 1 ? '' : 's'} that cover it (each gets a new version). The test cases themselves are kept.`
            : 'No test case covers it. This cannot be undone.'
        }
        confirmLabel="Delete requirement"
        tone="danger"
        onConfirm={() => {
          const r = deleting;
          if (r === null) return;
          del.mutate(
            { projectKey, key: r.key },
            {
              onSuccess: () => {
                void refresh();
                setNotice({ tone: 'success', text: `Deleted ${r.key}` });
              },
            },
          );
        }}
      />
    </>
  );
}
