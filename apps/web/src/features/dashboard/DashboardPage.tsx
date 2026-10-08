import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';

import { useDashboardLiveUpdates, useLiveStep } from './live';
import { relativeTime, runMeta, type RecentRun } from './model';

import { ModeMixBar } from '@/components/app/ModeMixBar';
import { PageHeader } from '@/components/app/PageHeader';
import { Sparkline, StatTile, StatTileSkeleton } from '@/components/app/StatTile';
import { Button, Callout, Card, CardHeader, EmptyState, LinkButton, Skeleton, StatusPill } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type ProjectRow = RouterOutputs['projects']['list'][number];

const linkClass = 'text-primary-text hover:text-primary-text-hover';

/** Internal link; `to` is a runtime string so the generated route union is bypassed. */
function A({ to, className, children, ...rest }: { to: string; className?: string; children: React.ReactNode; 'aria-label'?: string }) {
  return (
    <Link to={to as never} className={className ?? linkClass} {...rest}>
      {children}
    </Link>
  );
}

function SearchBox() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void navigate({ to: '/search', search: { q: q.trim() } as never });
  };
  return (
    <form
      role="search"
      onSubmit={submit}
      className="flex min-h-[44px] items-center gap-2 rounded-control border border-line-input bg-surface px-3 text-sm text-muted"
    >
      <label htmlFor="dash-search">Search</label>
      <input
        id="dash-search"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Cases, runs, defects"
        className="w-[200px] max-w-full border-0 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
      />
    </form>
  );
}

const PROJECT_STATUS: Record<ProjectRow['status'], { status: string; label?: string }> = {
  none: { status: 'draft', label: 'No runs' },
  running: { status: 'running' },
  passing: { status: 'passed' },
  failing: { status: 'failed' },
};

function ProjectsTable({ projects }: { projects: ProjectRow[] }) {
  const envQueries = trpc.useQueries((t) => projects.map((p) => t.environments.list({ projectKey: p.key })));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-[0.05em] text-muted">
            <th scope="col" className="px-[18px] py-2.5 font-medium">Project</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Environments</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Cases</th>
            <th scope="col" className="px-3 py-2.5 font-medium">Last run</th>
            <th scope="col" className="px-3 py-2.5 font-medium">System 1 model</th>
            <th scope="col" className="px-[18px] py-2.5 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p, i) => {
            const envs = envQueries[i]?.data;
            const pill = PROJECT_STATUS[p.status];
            return (
              <tr key={p.key} className="border-t border-divider-row">
                <td className="px-[18px] py-3.5">
                  <A to={`/p/${encodeURIComponent(p.key)}/cases`} className="font-semibold text-primary-text no-underline hover:text-primary-text-hover">
                    {p.key} · {p.name}
                  </A>
                </td>
                <td className="px-3 py-3.5">{envs ? envs.map((e) => e.name).join(' · ') : `${p.counts.environments}`}</td>
                <td className="px-3 py-3.5 font-mono">{p.counts.cases}</td>
                <td className="px-3 py-3.5">
                  {p.lastRun ? (
                    <A to={`/p/${encodeURIComponent(p.key)}/runs/${encodeURIComponent(p.lastRun.id)}`}>
                      <time dateTime={p.lastRun.startedAt ?? undefined}>{relativeTime(p.lastRun.startedAt)}</time>
                    </A>
                  ) : (
                    <span className="text-muted">Never</span>
                  )}
                </td>
                <td className="px-3 py-3.5 font-mono text-[13px]">{p.s1Model ?? <span className="text-muted">Not set</span>}</td>
                <td className="px-[18px] py-3.5">
                  <StatusPill status={pill.status} {...(pill.label ? { label: pill.label } : {})} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RunRow({ run, last }: { run: RecentRun; last: boolean }) {
  const live = useLiveStep(run.id, run.status === 'running');
  const base = `/p/${encodeURIComponent(run.projectKey)}/runs/${encodeURIComponent(run.id)}`;
  const label = run.status === 'cancelled' ? { label: 'Cancelled' } : {};
  return (
    <Link
      to={(run.status === 'running' ? `${base}/live` : base) as never}
      className={`flex items-center justify-between gap-3 px-[18px] py-3.5 text-fg no-underline hover:bg-surface-subtle ${last ? '' : 'border-b border-divider-row'}`}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-semibold">{run.title}</span>
        <span className="text-[13px] text-muted">{runMeta(run, live)}</span>
      </span>
      <StatusPill status={run.status === 'cancelled' ? 'skipped' : run.status} {...label} />
    </Link>
  );
}

function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <Callout tone="danger" className="m-[18px] flex flex-wrap items-center justify-between gap-3">
      <span>Could not load this section: {errorMessage(error)}</span>
      <Button size="sm" onClick={onRetry}>Retry</Button>
    </Callout>
  );
}

/** Home screen (`/`): metric tiles, projects, recent runs and the execution mode mix (wireframe 01). */
export function DashboardPage() {
  useDashboardLiveUpdates();
  const summary = trpc.dashboard.summary.useQuery(undefined, { refetchInterval: 60_000 });
  const projects = trpc.projects.list.useQuery();
  const recent = trpc.runs.recent.useQuery({ limit: 8 }, { refetchInterval: 60_000 });

  const first = projects.data?.[0]?.key;
  const projectBase = first !== undefined ? `/p/${encodeURIComponent(first)}` : null;
  const s = summary.data;
  const runningRun = recent.data?.find((r) => r.status === 'running');

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Dashboard"
        actions={
          <>
            <SearchBox />
            <LinkButton to="/projects/new">New project</LinkButton>
            <LinkButton variant="primary" to={projectBase !== null ? `${projectBase}/plans` : '/projects/new'}>
              Run a plan
            </LinkButton>
          </>
        }
      />

      <section aria-label="Key metrics" className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        {summary.isError ? (
          <Card className="col-span-full">
            <QueryError error={summary.error} onRetry={() => void summary.refetch()} />
          </Card>
        ) : s === undefined ? (
          <>
            <StatTileSkeleton label="Pass rate · last 7 days" />
            <StatTileSkeleton label="Runs today" />
            <StatTileSkeleton label="Needs review" />
            <StatTileSkeleton label="Flaky cases" />
          </>
        ) : (
          <>
            <StatTile label="Pass rate · last 7 days" value={s.passRate7d === null ? '—' : `${s.passRate7d}%`}>
              <Sparkline
                values={s.passRateSeries}
                label={s.passRate7d === null ? 'No results in the last 7 days' : 'Daily pass rate, last 7 days'}
              />
            </StatTile>
            <StatTile label="Runs today" value={s.runsToday}>
              <div className="text-[13px] text-strong-2">
                {s.runningNow} running now
                {runningRun !== undefined && (
                  <>
                    {' · '}
                    <A to={`/p/${encodeURIComponent(runningRun.projectKey)}/runs/${encodeURIComponent(runningRun.id)}/live`}>watch</A>
                  </>
                )}
              </div>
            </StatTile>
            <StatTile label="Needs review" value={s.needsReview} tone="warning">
              <div className="text-[13px] text-strong-2">
                AI verdicts + heal proposals
                {projectBase !== null && (
                  <>
                    {' · '}
                    <A to={`${projectBase}/review`}>open queue</A>
                  </>
                )}
              </div>
            </StatTile>
            <StatTile label="Flaky cases" value={s.flaky}>
              <div className="text-[13px] text-strong-2">Quarantined: {s.quarantined}</div>
            </StatTile>
          </>
        )}
      </section>

      <div className="flex flex-wrap items-start gap-5">
        <Card aria-label="Projects" className="flex min-w-0 flex-[3_1_560px] flex-col">
          <CardHeader title="Projects" action={<A to="/projects/new">+ New project</A>} />
          {projects.isLoading ? (
            <div className="flex flex-col gap-3 p-[18px]">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          ) : projects.isError ? (
            <QueryError error={projects.error} onRetry={() => void projects.refetch()} />
          ) : projects.data && projects.data.length > 0 ? (
            <ProjectsTable projects={projects.data} />
          ) : (
            <div className="p-[18px]">
              <EmptyState action={<LinkButton variant="primary" to="/projects/new">Create your first project</LinkButton>}>
                No projects yet. Create your first project to start testing.
              </EmptyState>
            </div>
          )}
        </Card>

        <Card aria-label="Recent runs" className="flex min-w-0 flex-[2_1_340px] flex-col">
          <CardHeader title="Recent runs" action={projectBase !== null ? <A to={`${projectBase}/runs`}>All runs</A> : undefined} />
          {recent.isLoading ? (
            <div className="flex flex-col gap-3 p-[18px]">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : recent.isError ? (
            <QueryError error={recent.error} onRetry={() => void recent.refetch()} />
          ) : recent.data && recent.data.length > 0 ? (
            recent.data.map((run, i) => <RunRow key={run.id} run={run} last={i === (recent.data?.length ?? 0) - 1} />)
          ) : (
            <div className="p-[18px]">
              <EmptyState>No runs yet. Runs you start appear here.</EmptyState>
            </div>
          )}
        </Card>
      </div>

      <Card aria-label="Execution mode mix" className="flex flex-col gap-3.5 p-[18px]">
        <div className="flex flex-wrap justify-between gap-2">
          <h2 className="text-base font-semibold text-fg">How steps were executed · last 7 days</h2>
          <span className="text-[13px] text-muted">Replay = no model call · Heal = S1 fixed a step · Explore = S1 drove the step</span>
        </div>
        {summary.isError ? null : s === undefined ? (
          <Skeleton className="h-7 w-full" />
        ) : (
          <>
            <ModeMixBar mix={s.modeMix7d} />
            {s.modeMix7d.replay + s.modeMix7d.heal + s.modeMix7d.explore === 0 && (
              <p className="text-[13px] text-muted">No steps were executed in the last 7 days.</p>
            )}
          </>
        )}
      </Card>
    </>
  );
}
