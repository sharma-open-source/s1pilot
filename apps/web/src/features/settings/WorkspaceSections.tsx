import { useEffect, useState } from 'react';

import { Button, Callout, Card, CardHeader, ConfirmDialog, EmptyState, Field, Input, Pill, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';

function Loading() {
  return (
    <Card className="flex flex-col gap-3 p-5" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
    </Card>
  );
}

function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <Callout tone="danger" className="flex flex-wrap items-center justify-between gap-3">
      <span>{errorMessage(error)}</span>
      <Button onClick={retry}>Retry</Button>
    </Callout>
  );
}

/** General: workspace name and default timezone. */
export function GeneralSection() {
  const utils = trpc.useUtils();
  const q = trpc.workspace.get.useQuery();
  const update = trpc.workspace.update.useMutation();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    if (q.data) {
      setName(q.data.name);
      setTimezone(q.data.timezone);
    }
  }, [q.data]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <LoadError error={q.error} retry={() => void q.refetch()} />;

  const save = async () => {
    setMsg(null);
    try {
      await update.mutateAsync({ name, timezone });
      await utils.workspace.get.invalidate();
      setMsg({ tone: 'success', text: 'Saved' });
    } catch (err) {
      setMsg({ tone: 'danger', text: errorMessage(err) });
    }
  };

  return (
    <Card aria-label="General" className="flex flex-col gap-4 p-5">
      <h2 className="text-[17px] font-semibold text-fg">General</h2>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        <Field label="Workspace name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Default timezone" hint="IANA name, for example Europe/Berlin. Used for plan schedules without their own timezone.">
          {(id) => <Input id={id} mono value={timezone} onChange={(e) => setTimezone(e.target.value)} />}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={update.isPending || name.trim() === ''} onClick={() => void save()}>
          Save
        </Button>
        {msg && (
          <span role={msg.tone === 'danger' ? 'alert' : 'status'} className={msg.tone === 'danger' ? 'text-sm text-danger' : 'text-sm text-success'}>
            {msg.text}
          </span>
        )}
      </div>
    </Card>
  );
}

/** Data & retention: default retention days and "Purge now" per project (with confirmation). */
export function DataSection() {
  const utils = trpc.useUtils();
  const general = trpc.workspace.get.useQuery();
  const data = trpc.workspace.data.useQuery();
  const update = trpc.workspace.update.useMutation();
  const [days, setDays] = useState('30');
  const [confirm, setConfirm] = useState<string | null>(null);
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    if (general.data) setDays(String(general.data.retentionDays));
  }, [general.data]);

  if (general.isLoading || data.isLoading) return <Loading />;
  if (general.error || data.error) return <LoadError error={general.error ?? data.error} retry={() => void data.refetch()} />;

  const parsed = Number(days);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650;

  const save = async () => {
    setResult(null);
    try {
      await update.mutateAsync({ retentionDays: parsed });
      await utils.workspace.get.invalidate();
      setResult({ tone: 'success', text: 'Default retention saved. It applies to new projects.' });
    } catch (err) {
      setResult({ tone: 'danger', text: errorMessage(err) });
    }
  };

  const purge = async (key: string) => {
    setConfirm(null);
    setResult(null);
    try {
      const r = await utils.client.workspace.purge.mutate({ projectKey: key });
      await utils.workspace.data.invalidate();
      setResult({ tone: 'success', text: `Purged ${r.removed} artifact${r.removed === 1 ? '' : 's'} of ${key}.` });
    } catch (err) {
      setResult({ tone: 'danger', text: errorMessage(err) });
    }
  };

  return (
    <>
      <Card aria-label="Retention" className="flex flex-col gap-4 p-5">
        <h2 className="text-[17px] font-semibold text-fg">Data &amp; retention</h2>
        <Field
          label="Default retention (days)"
          hint="Screenshots, traces and logs older than this are deleted daily. Applies to new projects; existing projects keep their own value."
          className="max-w-[320px]"
        >
          {(id) => (
            <Input id={id} mono type="number" min={1} max={3650} value={days} aria-invalid={!valid} onChange={(e) => setDays(e.target.value)} />
          )}
        </Field>
        <div>
          <Button variant="primary" disabled={!valid || update.isPending} onClick={() => void save()}>
            Save retention
          </Button>
        </div>
        {result && <Callout tone={result.tone}>{result.text}</Callout>}
      </Card>
      <Card aria-label="Projects data">
        <CardHeader title="Stored artifacts by project" />
        {(data.data?.length ?? 0) === 0 ? (
          <div className="p-[18px]">
            <EmptyState>No projects yet.</EmptyState>
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {data.data?.map((p) => (
              <li key={p.key} className="flex flex-wrap items-center justify-between gap-3 border-b border-divider-row px-[18px] py-3 last:border-b-0">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium text-fg">
                    <span className="font-mono">{p.key}</span> · {p.name}
                  </span>
                  <span className="text-xs text-secondary">
                    <span className="font-mono">{p.artifacts}</span> artifacts · keeps <span className="font-mono">{p.retentionDays}</span> days
                  </span>
                </div>
                <Button variant="danger-outline" disabled={p.artifacts === 0} onClick={() => setConfirm(p.key)} aria-label={`Purge now ${p.key}`}>
                  Purge now
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Purge artifacts of ${confirm ?? ''}?`}
        description="Deletes all screenshots, traces, videos and logs stored for this project, regardless of age. Run results and verdicts stay."
        confirmLabel="Purge now"
        tone="danger"
        onConfirm={() => confirm !== null && void purge(confirm)}
      />
    </>
  );
}

const WORKER_TONE = { idle: 'neutral', busy: 'running', stopped: 'danger' } as const;

/** Workers: in-process workers, status and current job (refreshes every 3 s). */
export function WorkersSection() {
  const q = trpc.workspace.workers.useQuery(undefined, { refetchInterval: 3000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <LoadError error={q.error} retry={() => void q.refetch()} />;
  const workers = q.data?.workers ?? [];
  return (
    <Card aria-label="Workers">
      <CardHeader title="Workers" action={<span className="text-[13px] text-secondary">In-process · {q.data?.configured ?? 0} configured</span>} />
      {workers.length === 0 ? (
        <div className="p-[18px]">
          <EmptyState>No workers are running. Start the server with <span className="font-mono">--workers 1</span> or more to execute runs.</EmptyState>
        </div>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {workers.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-divider-row px-[18px] py-3 last:border-b-0">
              <span className="font-mono text-sm text-fg">{w.id}</span>
              <Pill tone={WORKER_TONE[w.status]}>{w.status === 'busy' ? 'Busy' : w.status === 'idle' ? 'Idle' : 'Stopped'}</Pill>
              <span className="min-w-[160px] flex-1 text-right font-mono text-xs text-secondary">
                {w.status === 'busy' ? `job ${w.jobId ?? ''}${w.runId ? ` · run ${w.runId}` : ''}` : 'No current job'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
