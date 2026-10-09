import { Link } from '@tanstack/react-router';

import { queueStatusKey } from './model';

import { PageHeader } from '@/components/app/PageHeader';
import { Callout, Card, EmptyState, LinkButton, Skeleton, StatusPill } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

/** Manual testing landing page (`/p/:key/manual`): the caller's assigned manual and hybrid cases. */
export function ManualQueuePage({ projectKey }: { projectKey: string }) {
  const queue = trpc.manual.myQueue.useQuery({ projectKey });
  const items = queue.data ?? [];
  const next = items.find((i) => i.status === 'in-progress') ?? items.find((i) => i.status === 'todo');
  return (
    <>
      <PageHeader
        eyebrow="Manual testing / assigned to you"
        title="Manual testing"
        actions={
          next && (
            <LinkButton variant="ink" to={`/p/${projectKey}/manual/${next.id}`}>
              {next.status === 'in-progress' ? 'Continue testing' : 'Start testing'}
            </LinkButton>
          )
        }
      />
      {queue.isError && <Callout tone="danger">Could not load your queue: {errorMessage(queue.error)}</Callout>}
      <Card aria-label="My queue" className="overflow-hidden">
        {queue.isLoading ? (
          <div className="flex flex-col gap-3 p-4" aria-busy="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : items.length === 0 ? (
          <div className="p-4">
            <EmptyState>Nothing is assigned to you. Mark cases as manual in a test plan and run it to fill this queue.</EmptyState>
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            {items.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-divider-row px-[18px] py-3 first:border-t-0">
                <Link to={`/p/${projectKey}/manual/${i.id}` as never} className="flex min-h-[44px] min-w-0 flex-wrap items-center gap-3 text-fg no-underline hover:underline">
                  <span className="font-mono text-sm">{i.caseKey}</span>
                  <span className="text-sm">{i.title}</span>
                  {i.hybrid && <span className="text-xs text-muted">hybrid</span>}
                </Link>
                <StatusPill status={queueStatusKey(i.status, i.verdict)} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
