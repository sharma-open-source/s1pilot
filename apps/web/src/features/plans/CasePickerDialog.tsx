import { keepPreviousData } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { QueryInput } from '@/components/app/QueryInput';
import { Button, Callout, Dialog, EmptyState, Pagination, pageCountOf, Skeleton, StatusPill } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

const PAGE_SIZE = 25;

interface Props {
  projectKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ids already in the plan. */
  initial: string[];
  onConfirm: (caseIds: string[]) => void;
  /** Dialog subtitle. Default: for plans. */
  description?: string;
  /** Confirm button text for `n` picked cases. Default `Use n cases`. */
  confirmLabel?: (n: number) => string;
}

/** Dialog with the test-case table (same columns as the library) and checkboxes, for hand-picked plans. */
export function CasePickerDialog({ projectKey, open, onOpenChange, initial, onConfirm, description, confirmLabel }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initial));
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (open) {
      setSelected(new Set(initial));
      setFilter('');
      setQ('');
      setPage(1);
    }
  }, [open]);
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(filter.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [filter]);

  const list = trpc.cases.list.useQuery(
    { projectKey, ...(q !== '' ? { query: q } : {}), page, pageSize: PAGE_SIZE },
    { enabled: open, placeholderData: keepPreviousData },
  );
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = pageCountOf(total, PAGE_SIZE);
  const allOnPage = items.length > 0 && items.every((c) => selected.has(c.id));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const c of items) {
        if (allOnPage) next.delete(c.id);
        else next.add(c.id);
      }
      return next;
    });

  return (
    <Dialog
      wide
      open={open}
      onOpenChange={onOpenChange}
      title="Pick test cases"
      description={description ?? 'Tick the cases this plan should run.'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onConfirm([...selected]);
              onOpenChange(false);
            }}
          >
            {confirmLabel ? confirmLabel(selected.size) : `Use ${selected.size} ${selected.size === 1 ? 'case' : 'cases'}`}
          </Button>
        </>
      }
    >
      <QueryInput label="Filter" placeholder="tags:checkout AND priority<=P1" value={filter} onChange={setFilter} />
      {list.isError && <Callout tone="danger">{errorMessage(list.error)}</Callout>}
      <div className="overflow-x-auto rounded-card border border-line">
        <table className="w-full min-w-[520px] border-collapse text-sm">
          <caption className="sr-only">Test cases</caption>
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.05em] text-muted">
              <th className="w-12 px-4 py-2.5 font-medium">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  className="h-[18px] w-[18px] accent-primary"
                  checked={allOnPage}
                  disabled={items.length === 0}
                  onChange={toggleAll}
                />
              </th>
              <th scope="col" className="px-2 py-2.5 font-medium">Key</th>
              <th scope="col" className="px-2 py-2.5 font-medium">Title</th>
              <th scope="col" className="px-2 py-2.5 font-medium">Priority</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading &&
              [0, 1, 2].map((i) => (
                <tr key={i} className="border-t border-divider-row">
                  <td colSpan={5} className="px-4 py-3">
                    <Skeleton className="h-8" />
                  </td>
                </tr>
              ))}
            {items.map((c) => (
              <tr key={c.id} className="border-t border-divider-row">
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Pick ${c.key}`}
                    className="h-[18px] w-[18px] accent-primary"
                    checked={selected.has(c.id)}
                    onChange={() => toggle(c.id)}
                  />
                </td>
                <td className="whitespace-nowrap px-2 py-3 font-mono text-[13px]">{c.key}</td>
                <td className="px-2 py-3">{c.title}</td>
                <td className="px-2 py-3">{c.priority}</td>
                <td className="px-4 py-3">
                  <StatusPill status={c.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.isSuccess && items.length === 0 && (
          <div className="p-4">
            <EmptyState>{q !== '' ? 'No test cases match this filter.' : 'This project has no test cases yet.'}</EmptyState>
          </div>
        )}
      </div>
      <Pagination page={page} pageCount={pageCount} shown={items.length} total={total} onPageChange={setPage} className="border-t-0 px-0 py-0" />
    </Dialog>
  );
}
