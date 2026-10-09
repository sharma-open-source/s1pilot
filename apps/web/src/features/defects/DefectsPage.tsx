import { keepPreviousData } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  environmentLine,
  failingLabel,
  SEVERITIES,
  severityLabel,
  severityTone,
  shortSha,
  STATUSES,
  statusText,
  type DefectsSearch,
} from './model';

import { PageHeader } from '@/components/app/PageHeader';
import { QueryInput } from '@/components/app/QueryInput';
import { ExpectedActual } from '@/components/app/report';
import { Button, Callout, Card, Checkbox, EmptyState, Field, Input, Pill, Select, Skeleton, Tag, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { useProjects } from '@/lib/nav-data';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Row = RouterOutputs['defects']['list']['items'][number];
type Draft = RouterOutputs['defects']['createFromResult'];
type Details = Draft['details'];

const artifactUrl = (id: string): string => `/api/artifacts/${encodeURIComponent(id)}`;
const ASIDE = 'flex min-w-0 flex-[1_1_340px] flex-col gap-3.5 rounded-card border border-line bg-surface p-5 text-sm';

interface DefectsPageProps {
  projectKey: string;
  search: DefectsSearch;
  onSearch: (next: DefectsSearch, opts?: { replace?: boolean }) => void;
}

/** Defects screen (`/p/:key/defects`): filterable list plus the New defect / defect detail aside. */
export function DefectsPage({ projectKey, search, onSearch }: DefectsPageProps) {
  const projectName = useProjects().data?.find((p) => p.key === projectKey)?.name;
  const q = search.q ?? '';
  const [text, setText] = useState(q);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => setText(q), [q]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const list = trpc.defects.list.useQuery({ projectKey, query: q }, { placeholderData: keepPreviousData });
  const items = list.data?.items ?? [];

  const onFilter = (value: string) => {
    setText(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onSearch({ ...(value ? { q: value } : {}), ...(search.defect ? { defect: search.defect } : {}) }, { replace: true }), 300);
  };
  const creating = search.defect === undefined;
  const open = (next: DefectsSearch) => onSearch({ ...(q ? { q } : {}), ...next });

  return (
    <>
      <PageHeader
        eyebrow={`${projectName !== undefined ? `${projectKey} · ${projectName}` : projectKey} · Local defects`}
        title="Defects"
        actions={
          <>
            <QueryInput
              label="Filter"
              value={text}
              onChange={onFilter}
              aria-label="Filter defects"
              placeholder="status:open"
              className="flex-none"
            />
            <Button variant="primary" className="bg-danger" onClick={() => open({ new: true })}>
              New defect
            </Button>
          </>
        }
      />

      {list.isError && (
        <Callout tone="danger" role="alert">
          {q ? `Filter problem: ${errorMessage(list.error)}` : `Could not load defects: ${errorMessage(list.error)}`}
        </Callout>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <Card aria-label="Defect list" className="min-w-0 flex-[999_1_560px]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-[0.05em] text-muted">
                  <th scope="col" className="px-[18px] py-3 font-medium">ID</th>
                  <th scope="col" className="px-2.5 py-3 font-medium">Title</th>
                  <th scope="col" className="px-2.5 py-3 font-medium">Severity</th>
                  <th scope="col" className="px-2.5 py-3 font-medium">Failing results</th>
                  <th scope="col" className="px-2.5 py-3 font-medium">Tracker</th>
                  <th scope="col" className="px-[18px] py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.isLoading ? (
                  [0, 1, 2].map((i) => (
                    <tr key={i} className="border-t border-divider-row">
                      <td colSpan={6} className="px-[18px] py-3.5">
                        <Skeleton className="h-8 w-full" />
                      </td>
                    </tr>
                  ))
                ) : (
                  items.map((d) => <DefectRow key={d.id} row={d} selected={d.id === search.defect} onSelect={() => open({ defect: d.id })} />)
                )}
              </tbody>
            </table>
          </div>
          {!list.isLoading && items.length === 0 && !list.isError && (
            <div className="p-4">
              <EmptyState>
                {(list.data?.total ?? 0) > 0
                  ? 'No defects match this filter.'
                  : 'No defects yet. Create one from a failed result in a run report, or use New defect.'}
              </EmptyState>
            </div>
          )}
        </Card>

        {creating ? (
          <NewDefect
            key={`${search.fromResult ?? ''}:${search.step ?? ''}:${search.title ?? ''}`}
            projectKey={projectKey}
            search={search}
            onCreated={(id) => open({ defect: id })}
          />
        ) : (
          <DefectDetail key={search.defect} id={search.defect as string} onClose={() => open({ new: true })} />
        )}
      </div>
    </>
  );
}

function DefectRow({ row, selected, onSelect }: { row: Row; selected: boolean; onSelect: () => void }) {
  return (
    <tr aria-selected={selected} className={cn('border-t border-divider-row', selected && 'bg-surface-selected')}>
      <td className="whitespace-nowrap px-[18px] py-3.5 font-mono text-[13px]">{row.key}</td>
      <td className="px-2.5 py-3.5">
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? 'true' : undefined}
          className="min-h-[44px] cursor-pointer border-0 bg-transparent p-0 text-left font-sans text-sm text-fg"
        >
          <strong className="block font-semibold">{row.title}</strong>
          <span className="block text-xs text-secondary">{row.source ? `from ${row.source}` : 'created manually'}</span>
        </button>
      </td>
      <td className="px-2.5 py-3.5">
        <Tag tone={severityTone(row.severity)} className="font-semibold">
          {severityLabel(row.severity)}
        </Tag>
      </td>
      <td className="px-2.5 py-3.5">{failingLabel(row.failingBrowsers)}</td>
      <td className="px-2.5 py-3.5 font-mono text-[13px]">
        {row.tracker ? (
          row.tracker.url ? (
            <a href={row.tracker.url} target="_blank" rel="noreferrer" className="text-primary-text">
              {row.tracker.id} ↗
            </a>
          ) : (
            row.tracker.id
          )
        ) : (
          <span className="font-sans text-secondary">Not pushed</span>
        )}
      </td>
      <td className="px-[18px] py-3.5">{statusText(row.status, row.retestRunId)}</td>
    </tr>
  );
}

/* ---------------------------------------------------------------- shared pieces */

function Steps({ steps }: { steps: string[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">Steps to reproduce · auto</span>
      <div className="rounded-control bg-surface-subtle px-3 py-2.5 text-[13px] leading-relaxed">
        {steps.length === 0 ? (
          <span className="text-secondary">No steps were recorded.</span>
        ) : (
          <ol className="m-0 list-none p-0">
            {steps.map((s, i) => (
              <li key={i}>
                {i + 1}. {s}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Attachments({ details }: { details: Pick<Details, 'evidence' | 'environment' | 'browser' | 'buildRef'> }) {
  const env = environmentLine(details.environment, details.browser);
  const parts: ReactNode[] = details.evidence.map((e) => (
    <a key={e.artifactId} href={artifactUrl(e.artifactId)} target="_blank" rel="noreferrer" className="text-primary-text">
      {e.kind}
    </a>
  ));
  if (env) parts.push(`environment (${env})`);
  if (details.buildRef) {
    parts.push(
      <span key="build">
        build <span className="font-mono">{shortSha(details.buildRef)}</span>
      </span>,
    );
  }
  return (
    <div className="text-[13px] text-secondary">
      Attached:{' '}
      {parts.length === 0
        ? 'nothing yet'
        : parts.map((p, i) => (
            <span key={i}>
              {i > 0 && ', '}
              {p}
            </span>
          ))}
    </div>
  );
}

function SeveritySelect({ value, onChange }: { value: string; onChange: (v: 'S1' | 'S2' | 'S3' | 'S4') => void }) {
  return (
    <Field label="Severity">
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value as 'S1' | 'S2' | 'S3' | 'S4')}>
          {SEVERITIES.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function PushToTracker() {
  return (
    <Checkbox
      label="Push to tracker"
      disabled
      checked={false}
      readOnly
      title="Issue tracker sync arrives with S-064"
      aria-describedby="push-hint"
    />
  );
}

/* ---------------------------------------------------------------- new defect */

function NewDefect({ projectKey, search, onCreated }: { projectKey: string; search: DefectsSearch; onCreated: (id: string) => void }) {
  const draft = trpc.defects.createFromResult.useQuery(
    { resultId: search.fromResult as string, ...(search.step !== undefined ? { stepIndex: search.step } : {}) },
    { enabled: search.fromResult !== undefined },
  );
  if (search.fromResult !== undefined) {
    if (draft.isLoading) {
      return (
        <aside aria-label="Create defect" className={ASIDE}>
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-24 w-full" />
        </aside>
      );
    }
    if (draft.isError || !draft.data) {
      return (
        <aside aria-label="Create defect" className={ASIDE}>
          <Callout tone="danger">Could not prefill from this result: {errorMessage(draft.error)}</Callout>
        </aside>
      );
    }
    return <NewDefectForm projectKey={projectKey} draft={draft.data} onCreated={onCreated} />;
  }
  return <NewDefectForm projectKey={projectKey} manual={{ title: search.title ?? '', source: search.source }} onCreated={onCreated} />;
}

function NewDefectForm({
  projectKey,
  draft,
  manual,
  onCreated,
}: {
  projectKey: string;
  draft?: Draft;
  manual?: { title: string; source: string | undefined };
  onCreated: (id: string) => void;
}) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState(draft?.title ?? manual?.title ?? '');
  const [severity, setSeverity] = useState<'S1' | 'S2' | 'S3' | 'S4'>(draft?.severity ?? 'S3');
  const [retest, setRetest] = useState(true);
  const [steps, setSteps] = useState('');
  const [expected, setExpected] = useState('');
  const [actual, setActual] = useState('');
  const create = trpc.defects.create.useMutation({
    onSuccess: (d) => {
      void utils.defects.list.invalidate();
      void utils.defects.get.invalidate();
      onCreated(d.id);
    },
  });
  const details = draft?.details;
  const sourceLabel = details?.sourceLabel ?? manual?.source;

  const submit = () => {
    const base = details
      ? { ...details, retest }
      : {
          stepsToReproduce: steps.split('\n').map((s) => s.trim()).filter(Boolean),
          expected,
          actual,
          sourceKind: 'manual' as const,
          ...(sourceLabel ? { sourceLabel } : {}),
          retest,
        };
    create.mutate({ projectKey, title: title.trim(), severity, details: base, resultIds: draft ? [draft.resultId] : [] });
  };

  return (
    <aside aria-label="Create defect" className={ASIDE}>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim() !== '') submit();
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[17px] font-semibold">New defect</h2>
          <span className="text-[13px] text-secondary">
            {draft ? (
              <>
                Pre-filled from result <span className="font-mono">{details?.sourceLabel}</span> · step {draft.stepNumber}
              </>
            ) : (
              'Describe the problem and how to reproduce it.'
            )}
          </span>
        </div>
        <Field label="Title">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} />}</Field>
        <SeveritySelect value={severity} onChange={setSeverity} />
        {details ? (
          <>
            <Steps steps={details.stepsToReproduce} />
            <ExpectedActual expected={details.expected || 'Not recorded'} actual={details.actual || 'Not recorded'} />
            <Attachments details={details} />
          </>
        ) : (
          <>
            <Field label="Steps to reproduce" hint="One step per line">
              {(id) => <Textarea id={id} rows={4} value={steps} onChange={(e) => setSteps(e.target.value)} />}
            </Field>
            <Field label="Expected">{(id) => <Textarea id={id} rows={2} value={expected} onChange={(e) => setExpected(e.target.value)} />}</Field>
            <Field label="Actual">{(id) => <Textarea id={id} rows={2} value={actual} onChange={(e) => setActual(e.target.value)} />}</Field>
            <Attachments details={{ evidence: [], environment: undefined, browser: undefined, buildRef: undefined }} />
          </>
        )}
        <div className="flex flex-col gap-0.5">
          <PushToTracker />
          <span id="push-hint" className="pl-7 text-xs text-muted">
            Available once an issue tracker is connected (S-064).
          </span>
        </div>
        <Checkbox label="Re-test automatically when closed" checked={retest} onChange={(e) => setRetest(e.target.checked)} />
        {create.isError && <Callout tone="danger">{errorMessage(create.error)}</Callout>}
        <Button type="submit" variant="primary" className="bg-danger" disabled={create.isPending || title.trim() === ''}>
          Create defect
        </Button>
      </form>
    </aside>
  );
}

/* ---------------------------------------------------------------- selected defect */

function DefectDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const utils = trpc.useUtils();
  const query = trpc.defects.get.useQuery(id);
  if (query.isLoading) {
    return (
      <aside aria-label="Defect detail" className={ASIDE}>
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-24 w-full" />
      </aside>
    );
  }
  if (query.isError || !query.data) {
    return (
      <aside aria-label="Defect detail" className={ASIDE}>
        <Callout tone="danger">Could not load this defect: {errorMessage(query.error)}</Callout>
      </aside>
    );
  }
  return <DefectEditor key={query.data.defect.updatedAt} data={query.data} onNew={onClose} onSaved={() => void Promise.all([utils.defects.list.invalidate(), utils.defects.get.invalidate(id)])} />;
}

function DefectEditor({ data, onNew, onSaved }: { data: RouterOutputs['defects']['get']; onNew: () => void; onSaved: () => void }) {
  const { defect, key, projectKey, linked } = data;
  const details = defect.details;
  const [title, setTitle] = useState(defect.title);
  const [severity, setSeverity] = useState(defect.severity);
  const [status, setStatus] = useState(defect.status);
  const [retest, setRetest] = useState(details?.retest ?? false);
  const update = trpc.defects.update.useMutation({ onSuccess: onSaved });
  const dirty = title !== defect.title || severity !== defect.severity || status !== defect.status || retest !== (details?.retest ?? false);
  const queued = update.data?.details?.retestRunId ?? details?.retestRunId;

  return (
    <aside aria-label="Defect detail" className={ASIDE}>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          update.mutate({ id: defect.id, title: title.trim(), severity, status, details: { retest } });
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[17px] font-semibold">
            <span className="font-mono">{key}</span>
          </h2>
          <span className="text-[13px] text-secondary">{details?.sourceLabel ? `From ${details.sourceLabel}` : 'Created manually'}</span>
        </div>
        <Field label="Title">{(fid) => <Input id={fid} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} />}</Field>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3">
          <SeveritySelect value={severity} onChange={setSeverity} />
          <Field label="Status">
            {(fid) => (
              <Select id={fid} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                {STATUSES.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {details && (
          <>
            <Steps steps={details.stepsToReproduce} />
            <ExpectedActual expected={details.expected || 'Not recorded'} actual={details.actual || 'Not recorded'} />
            <Attachments details={details} />
          </>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Failing results</span>
          {linked.length === 0 ? (
            <span className="text-[13px] text-secondary">No results are linked.</span>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
              {linked.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/p/${encodeURIComponent(projectKey)}/runs/${encodeURIComponent(r.runId)}` as never}
                    search={{ result: r.id } as never}
                    className="font-mono text-primary-text"
                  >
                    {r.caseKey}
                  </Link>
                  <span>{r.caseTitle}</span>
                  <Pill tone={r.verdict === 'passed' ? 'success' : 'danger'}>{r.verdict}</Pill>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Checkbox label="Re-test automatically when closed" checked={retest} onChange={(e) => setRetest(e.target.checked)} />
        {queued && (
          <Callout tone="success">
            Re-test queued as run{' '}
            <Link to={`/p/${encodeURIComponent(projectKey)}/runs/${encodeURIComponent(queued)}` as never} className="font-mono text-primary-text">
              {queued.slice(0, 8)}
            </Link>
            .
          </Callout>
        )}
        {update.isError && <Callout tone="danger">{errorMessage(update.error)}</Callout>}
        <div className="flex flex-wrap gap-2.5">
          <Button type="submit" variant="primary" disabled={update.isPending || !dirty || title.trim() === ''}>
            Save changes
          </Button>
          <Button
            disabled={update.isPending || status === 'closed'}
            onClick={() => update.mutate({ id: defect.id, title: title.trim(), severity, status: 'closed', details: { retest } })}
          >
            Close defect
          </Button>
          <Button onClick={onNew}>New defect</Button>
        </div>
      </form>
    </aside>
  );
}
