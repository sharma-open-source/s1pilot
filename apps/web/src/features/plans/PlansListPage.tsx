import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { DeletePlanDialog } from './DeletePlanDialog';
import { describeCron, matrixSummary, type PlanEnv } from './model';

import { PageHeader } from '@/components/app/PageHeader';
import { Button, Callout, EmptyState, LinkButton, Skeleton, StatusPill } from '@/components/ui';
import { relativeTime } from '@/features/dashboard/model';
import { shortRunId } from '@/features/run-report/model';
import { errorMessage } from '@/lib/errors';
import { useProjects } from '@/lib/nav-data';
import { Can } from '@/lib/session';
import { trpc } from '@/lib/trpc';

/** Test plans list (`/p/:key/plans`): name, release, cases, matrix, schedule and last run status. */
export function PlansListPage({ projectKey }: { projectKey: string }) {
  const projectName = useProjects().data?.find((p) => p.key === projectKey)?.name;
  const plans = trpc.plans.list.useQuery({ projectKey });
  const envs = trpc.environments.list.useQuery({ projectKey });
  const base = `/p/${encodeURIComponent(projectKey)}/plans`;
  const rows = plans.data ?? [];
  const envList: PlanEnv[] = envs.data ?? [];
  const [toDelete, setToDelete] = useState<{ id: string; name: string } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  return (
    <>
      <PageHeader
        eyebrow={projectName !== undefined ? `${projectKey} · ${projectName}` : projectKey}
        title="Test plans"
        actions={
          <Can permission="plans:write">
            <LinkButton variant="primary" to={`${base}/new`}>
              New plan
            </LinkButton>
          </Can>
        }
      />
      {notice !== null && (
        <div role="status">
          <Callout tone={notice.tone}>{notice.text}</Callout>
        </div>
      )}
      <DeletePlanDialog
        plan={toDelete}
        onOpenChange={(open) => {
          if (!open) setToDelete(null);
        }}
        onDeleted={(plan) => setNotice({ tone: 'success', text: `Deleted plan "${plan.name}"` })}
        onError={(text) => setNotice({ tone: 'danger', text })}
      />
      {plans.isError && <Callout tone="danger">Could not load plans: {errorMessage(plans.error)}</Callout>}
      {plans.isLoading ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : rows.length === 0 && !plans.isError ? (
        <EmptyState action={<LinkButton to={`${base}/new`}>New plan</LinkButton>}>
          No test plans yet. A plan picks cases, where to run them and when.
        </EmptyState>
      ) : (
        <div className="relative overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[820px] border-collapse text-left text-sm">
            <caption className="sr-only">Test plans</caption>
            <thead className="bg-surface-subtle text-xs uppercase tracking-[0.05em] text-muted">
              <tr>
                {['Name', 'Release', 'Cases', 'Matrix', 'Schedule', 'Last run'].map((h) => (
                  <th key={h} scope="col" className="px-3.5 py-2.5 font-semibold">
                    {h}
                  </th>
                ))}
                <th scope="col" className="px-3.5 py-2.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-t border-divider-row align-middle">
                  <td className="px-3.5 py-3">
                    <Link to={`${base}/${encodeURIComponent(p.id)}` as never} className="inline-flex min-h-[44px] items-center font-medium text-primary-text">
                      {p.name}
                    </Link>
                  </td>
                  <td className="px-3.5 py-3 font-mono text-xs">{p.release !== undefined && p.release !== '' ? p.release : '–'}</td>
                  <td className="px-3.5 py-3">
                    {p.selection.kind === 'list' ? (
                      `${p.selection.caseIds.length} ${p.selection.caseIds.length === 1 ? 'case' : 'cases'}`
                    ) : (
                      <span className="font-mono text-xs" title={p.selection.query}>
                        query · {p.selection.query.length > 32 ? `${p.selection.query.slice(0, 32)}…` : p.selection.query}
                      </span>
                    )}
                  </td>
                  <td className="px-3.5 py-3">{matrixSummary(p.matrix, envList)}</td>
                  <td className="px-3.5 py-3">
                    {p.schedule !== undefined && p.schedule !== '' ? (
                      <span title={p.schedule}>{describeCron(p.schedule).text}</span>
                    ) : (
                      <span className="text-muted">Manual</span>
                    )}
                  </td>
                  <td className="px-3.5 py-3">
                    {p.lastRun !== null ? (
                      <span className="inline-flex flex-wrap items-center gap-2">
                        <StatusPill status={p.lastRun.status} />
                        <Link to={`/p/${encodeURIComponent(projectKey)}/runs/${encodeURIComponent(p.lastRun.id)}` as never} className="font-mono text-xs text-primary-text">
                          #{shortRunId(p.lastRun.id)}
                        </Link>
                        {p.lastRun.startedAt !== null && <time dateTime={p.lastRun.startedAt} className="text-xs text-secondary">{relativeTime(p.lastRun.startedAt)}</time>}
                      </span>
                    ) : (
                      <span className="text-muted">Never run</span>
                    )}
                  </td>
                  <td className="px-3.5 py-3 text-right">
                    <Button size="sm" variant="danger-outline" aria-label={`Delete plan ${p.name}`} onClick={() => setToDelete({ id: p.id, name: p.name })}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
