import { useState } from 'react';

import { ExitCriteriaTile } from './ExitCriteriaTile';
import { bucketOf, defaultFilter, matchesFilter, resultMeta, shortRunId, type ReportFilter } from './model';
import { ResultDetail } from './ResultDetail';

import { PageHeader } from '@/components/app/PageHeader';
import { ResultListItem } from '@/components/app/report';
import { StatTile, StatTileSkeleton } from '@/components/app/StatTile';
import {
  Breadcrumb,
  Button,
  Callout,
  Dialog,
  DropdownContent,
  DropdownItem,
  DropdownMenu,
  DropdownTrigger,
  EmptyState,
  Field,
  LinkButton,
  Segmented,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

export interface RunReportSearch {
  result?: string;
  filter?: ReportFilter;
}

interface RunReportPageProps {
  projectKey: string;
  runId: string;
  search: RunReportSearch;
  onSearch: (next: RunReportSearch, opts?: { replace?: boolean }) => void;
  /** Navigate to an in-app path (after "Rerun failed"). */
  navigate: (to: string) => void;
}

const FILTER_OPTIONS = [
  { value: 'failed', label: 'Failed' },
  { value: 'review', label: 'Review' },
  { value: 'all', label: 'All' },
] as const;

const NON_TERMINAL = ['queued', 'running', 'paused'];

/** Run report (`/p/:key/runs/:runId`): summary tiles, results list and result detail with evidence. */
export function RunReportPage({ projectKey, runId, search, onSearch, navigate }: RunReportPageProps) {
  const utils = trpc.useUtils();
  const query = trpc.runs.report.useQuery(runId);
  const rerun = trpc.runs.rerunFailed.useMutation({
    onSuccess: (run) => navigate(`/p/${encodeURIComponent(projectKey)}/runs/${encodeURIComponent(run.id)}/live`),
  });
  const [signing, setSigning] = useState(false);
  const [note, setNote] = useState('');
  const signOff = trpc.runs.signOff.useMutation({
    onSuccess: () => {
      setSigning(false);
      void utils.runs.report.invalidate(runId);
    },
  });
  const base = `/p/${encodeURIComponent(projectKey)}/runs/${encodeURIComponent(runId)}`;
  const runsPath = `/p/${encodeURIComponent(projectKey)}/runs`;

  const report = query.data;
  const results = report?.results ?? [];
  const selectedFromUrl = results.find((r) => r.id === search.result);
  const filter: ReportFilter =
    search.filter ?? (selectedFromUrl ? bucketOf(selectedFromUrl.verdict) : defaultFilter(results.map((r) => r.verdict)));
  const listed = results.filter((r) => matchesFilter(r.verdict, filter));
  const selected = selectedFromUrl ?? listed[0];

  const summary = report?.run.summary;
  const failedCount = (summary?.failed ?? 0) + (summary?.blocked ?? 0) + (summary?.flaky ?? 0);
  const live = report !== undefined && NON_TERMINAL.includes(report.run.status);

  const header = (
    <PageHeader
      eyebrow={
        <Breadcrumb
          items={[
            { label: 'Runs', to: runsPath },
            {
              label: (
                <>
                  Run <span className="font-mono">#{shortRunId(runId)}</span> · build{' '}
                  <span className="font-mono">{report?.run.buildRef ?? '–'}</span>
                </>
              ),
            },
          ]}
        />
      }
      title="Run report"
      actions={
        <>
          <DropdownMenu>
            <DropdownTrigger asChild>
              <Button>Export ▾</Button>
            </DropdownTrigger>
            <DropdownContent align="end">
              {(['junit', 'html', 'json'] as const).map((f) => (
                <DropdownItem key={f} asChild>
                  <a href={`/api/runs/${encodeURIComponent(runId)}/export/${f}`} download>
                    {f === 'junit' ? 'JUnit XML' : f === 'html' ? 'HTML report' : 'JSON'}
                  </a>
                </DropdownItem>
              ))}
              <DropdownItem asChild>
                <a href={`/api/runs/${encodeURIComponent(runId)}/export.pdf`} download>
                  PDF summary
                </a>
              </DropdownItem>
            </DropdownContent>
          </DropdownMenu>
          <Button disabled={live || report === undefined} onClick={() => setSigning(true)}>
            {report?.signOff ? 'Update sign-off' : 'Sign off'}
          </Button>
          <Button variant="primary" disabled={failedCount === 0 || rerun.isPending} onClick={() => rerun.mutate(runId)}>
            Rerun failed
          </Button>
        </>
      }
    />
  );

  if (query.isError) {
    return (
      <>
        {header}
        <Callout tone="danger">Could not load this run: {errorMessage(query.error)}</Callout>
      </>
    );
  }

  return (
    <>
      {header}
      <Dialog
        open={signing}
        onOpenChange={setSigning}
        title="Sign off this run"
        description={
          report?.exitCriteria && report.exitCriteria.met < report.exitCriteria.total
            ? `${report.exitCriteria.total - report.exitCriteria.met} exit criteria are not met. The sign-off records that.`
            : 'Records that you reviewed this run.'
        }
        footer={
          <>
            <Button onClick={() => setSigning(false)}>Cancel</Button>
            <Button variant="primary" disabled={signOff.isPending} onClick={() => signOff.mutate({ runId, note })}>
              Sign off
            </Button>
          </>
        }
      >
        <Field label="Note">
          {(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} rows={3} />}
        </Field>
        {signOff.isError && <Callout tone="danger">{errorMessage(signOff.error)}</Callout>}
      </Dialog>
      {rerun.isError && <Callout tone="danger">{errorMessage(rerun.error)}</Callout>}
      {live && (
        <Callout tone="info-ai" className="flex flex-wrap items-center justify-between gap-3">
          <span role="status">This run is still {report?.run.status}. Results below are partial.</span>
          <LinkButton to={`${base}/live`} variant="secondary" size="sm">
            Open live view
          </LinkButton>
        </Callout>
      )}

      <section aria-label="Summary" className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
        {summary === undefined ? (
          ['Passed', 'Failed', 'Needs review', 'Flaky / Blocked', 'Exit criteria'].map((l) => <StatTileSkeleton key={l} label={l} />)
        ) : (
          <>
            <StatTile label="Passed" value={summary.passed} />
            <StatTile label="Failed" value={summary.failed} tone="danger" />
            <StatTile label="Needs review" value={summary.needsReview} tone="warning" />
            <StatTile label="Flaky / Blocked" value={`${summary.flaky} / ${summary.blocked}`} />
            <ExitCriteriaTile criteria={report?.exitCriteria} signOff={report?.signOff} />
          </>
        )}
      </section>

      <div className="flex flex-wrap items-start gap-5">
        <section aria-label="Results" className="flex min-w-0 flex-[1_1_340px] max-w-[440px] flex-col rounded-card border border-line bg-surface max-[760px]:max-w-none">
          <div className="border-b border-divider p-3">
            <Segmented aria-label="Filter results" options={[...FILTER_OPTIONS]} value={filter} onChange={(f) => onSearch({ ...(search.result ? { result: search.result } : {}), filter: f })} />
          </div>
          {query.isLoading ? (
            <div className="flex flex-col gap-3 p-3.5">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : listed.length === 0 ? (
            <div className="p-3.5">
              <EmptyState>
                {results.length === 0
                  ? live
                    ? 'No case has finished yet.'
                    : 'This run has no results.'
                  : filter === 'failed'
                    ? 'No failed results in this run.'
                    : filter === 'review'
                      ? 'Nothing needs review.'
                      : 'No results.'}
              </EmptyState>
            </div>
          ) : (
            <div role="list" aria-label="Result list">
              {listed.map((r) => (
                <div role="listitem" key={r.id}>
                  <ResultListItem
                    resultKey={r.key}
                    title={r.title}
                    meta={resultMeta(r)}
                    status={r.verdict}
                    selected={selected?.id === r.id}
                    to={base}
                    search={{ result: r.id, filter }}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        {selected ? (
          <ResultDetail
            key={selected.id}
            resultId={selected.id}
            projectKey={projectKey}
            onChanged={() => {
              void utils.runs.report.invalidate(runId);
              void utils.runs.get.invalidate(runId);
              void utils.runs.list.invalidate();
            }}
          />
        ) : (
          !query.isLoading && (
            <section aria-label="Result detail" className="min-w-0 flex-[999_1_520px]">
              <EmptyState>Select a result to see its steps, decisions and evidence.</EmptyState>
            </section>
          )
        )}
      </div>
    </>
  );
}
