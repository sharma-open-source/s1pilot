import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { defaultTab, draftMetricsText, itemMeta, tabLabel, TABS, type ReviewStatusFilter, type ReviewTab } from './model';
import { ReviewDetail } from './ReviewDetail';

import { PageHeader } from '@/components/app/PageHeader';
import { ReviewListItem } from '@/components/app/review';
import { Button, Callout, EmptyState, Segmented, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { subscribeWorkspace, useProjects } from '@/lib/nav-data';
import { trpc } from '@/lib/trpc';

export interface ReviewSearch {
  tab?: ReviewTab;
  item?: string;
  status?: ReviewStatusFilter;
}

interface ReviewPageProps {
  projectKey: string;
  search: ReviewSearch;
  onSearch: (next: ReviewSearch, opts?: { replace?: boolean }) => void;
}

const EMPTY_TEXT: Record<ReviewTab, string> = {
  verdicts: 'No uncertain verdicts. Results the model is unsure about appear here.',
  heals: 'No heal proposals. Locator changes found during replay appear here.',
  drafts: 'No generated drafts. Use Generate from story in Test cases, or suggest tests by exploring the site when creating a project.',
  visual: 'Visual changes arrive with visual comparison, which is planned for a later phase.',
};

/** Review queue (`/p/:key/review`): tabs with live counts, item list and the heal / verdict detail. */
export function ReviewPage({ projectKey, search, onSearch }: ReviewPageProps) {
  const utils = trpc.useUtils();
  const projectName = useProjects().data?.find((p) => p.key === projectKey)?.name;
  const counts = trpc.reviews.counts.useQuery({ projectKey });
  const tab = search.tab ?? defaultTab(counts.data);
  const status: ReviewStatusFilter = search.status ?? 'pending';
  const [page, setPage] = useState(1);
  const list = trpc.reviews.list.useQuery({ projectKey, tab, status, page });
  const metrics = trpc.generate.metrics.useQuery({ projectKey }, { enabled: tab === 'drafts' });

  // Counts follow `/ws/workspace`: any change of the pending total refreshes the tabs and the list.
  useEffect(
    () =>
      subscribeWorkspace((message) => {
        if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'workspace') {
          void utils.reviews.counts.invalidate();
          void utils.reviews.list.invalidate();
        }
      }),
    [utils],
  );
  useEffect(() => setPage(1), [tab, status]);

  const base = `/p/${encodeURIComponent(projectKey)}/review`;
  const items = list.data?.items ?? [];
  const selected = items.find((i) => i.id === search.item) ?? items[0];
  const totalPages = Math.max(1, Math.ceil((list.data?.total ?? 0) / (list.data?.pageSize ?? 20)));
  const rowLabel = (i: { id: string; status: string }) => (i.status === 'approved' ? ('approved' as const) : i.status === 'rejected' ? ('rejected' as const) : undefined);

  return (
    <>
      <PageHeader
        eyebrow={projectName !== undefined ? `${projectKey} · ${projectName}` : projectKey}
        title="Review queue"
        actions={
          <p className="m-0 max-w-[420px] text-[13px] font-normal text-secondary">
            Every decision you make here is saved and used to recalibrate the model&apos;s confidence for this project.
          </p>
        }
      />

      <nav aria-label="Queue type" className="flex flex-wrap border-b border-line">
        {TABS.map((t) => (
          <Link
            key={t}
            to={base as never}
            search={{ tab: t, ...(status === 'resolved' ? { status } : {}) } as never}
            aria-current={tab === t ? 'page' : undefined}
            className={cn(
              '-mb-px inline-flex min-h-[44px] items-center border-b-2 px-3.5 py-2.5 text-sm no-underline',
              tab === t ? 'border-ink font-semibold text-fg' : 'border-transparent text-secondary',
            )}
          >
            {tabLabel(t, counts.data)}
          </Link>
        ))}
      </nav>

      {(counts.isError || list.isError) && <Callout tone="danger">Could not load the review queue: {errorMessage(list.error ?? counts.error)}</Callout>}

      {tab === 'drafts' && metrics.data && metrics.data.generated > 0 && (
        <p aria-label="Draft metrics" className="m-0 text-[13px] text-secondary">
          {draftMetricsText(metrics.data)}
          {metrics.data.acceptanceRate !== null ? ` · ${Math.round(metrics.data.acceptanceRate * 100)}% accepted` : ''}
        </p>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <section aria-label="Items" className="flex min-w-0 flex-[1_1_300px] max-w-[380px] flex-col rounded-card border border-line bg-surface max-[760px]:max-w-none">
          <div className="border-b border-divider p-3">
            <Segmented
              aria-label="Show items"
              options={[
                { value: 'pending', label: 'Pending' },
                { value: 'resolved', label: 'Resolved' },
              ]}
              value={status}
              onChange={(s) => onSearch({ tab, ...(s === 'resolved' ? { status: s } : {}) })}
            />
          </div>
          {list.isLoading ? (
            <div className="flex flex-col gap-3 p-3.5">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : items.length === 0 ? (
            <div className="p-3.5">
              <EmptyState>{status === 'resolved' ? 'Nothing has been decided in this tab yet.' : EMPTY_TEXT[tab]}</EmptyState>
            </div>
          ) : (
            <div role="list" aria-label="Review items">
              {items.map((i) => (
                <div role="listitem" key={i.id}>
                  <ReviewListItem
                    title={i.title}
                    meta={itemMeta(i)}
                    selected={selected?.id === i.id}
                    resolved={rowLabel(i)}
                    to={base}
                    search={{ tab, item: i.id, ...(status === 'resolved' ? { status } : {}) }}
                  />
                </div>
              ))}
            </div>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 border-t border-divider p-3 text-sm">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <span className="text-secondary">
                Page {page} of {totalPages}
              </span>
              <Button size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          )}
        </section>

        {selected ? (
          <ReviewDetail
            key={selected.id}
            id={selected.id}
            tab={tab}
            onDecided={(nextId) => onSearch({ tab, ...(nextId ? { item: nextId } : {}), ...(status === 'resolved' ? { status } : {}) }, { replace: true })}
          />
        ) : (
          !list.isLoading && (
            <section aria-label="Review detail" className="min-w-0 flex-[999_1_520px]">
              <EmptyState>{status === 'pending' ? 'All caught up. Select an item to see its detail.' : 'Select an item to see its detail.'}</EmptyState>
            </section>
          )
        )}
      </div>
    </>
  );
}
