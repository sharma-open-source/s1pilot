import { useState } from 'react';

import { timeAgo } from './model';

import { Button, Callout, Card, Dialog, Field, Input, Select, Skeleton } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Setup = RouterOutputs['auth']['list'][number];
type AssertionKind = 'text-visible' | 'text-absent' | 'url-contains';
type Method = 'record' | 'flow';
type Phase = 'form' | 'starting' | 'recording' | 'finishing';

const ASSERTION_LABEL: Record<AssertionKind, string> = {
  'text-visible': 'Page shows text',
  'text-absent': 'Page does not show text',
  'url-contains': 'URL contains',
};

function StatusText({ status }: { status: Setup['status'] }) {
  if (status === 'valid') return <span className="font-semibold text-success">Valid</span>;
  if (status === 'expired') return <span className="font-semibold text-warning">Expired</span>;
  return <span className="font-semibold text-secondary">Not recorded</span>;
}

function meta(s: Setup): string {
  if (s.status === 'expired') return s.kind === 'flow' ? `Flow ${s.flowId ?? ''} · refresh to log in again` : 'Saved session no longer valid · record again or refresh';
  if (s.status === 'never') return s.kind === 'flow' ? `Flow ${s.flowId ?? ''} · not run yet` : 'No session saved yet';
  return `Saved session reused by every run · refreshed ${timeAgo(s.lastRefreshedAt)}`;
}

/**
 * Dialog that records a login (or defines a flow login). A validation page and assertion are required: without
 * one the server would treat any stored state as valid.
 */
function RecordLoginDialog({ envId, open, onOpenChange, onDone }: { envId: string; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [method, setMethod] = useState<Method>('record');
  const [name, setName] = useState('login-as-customer');
  const [flowId, setFlowId] = useState('');
  const [url, setUrl] = useState('/account');
  const [kind, setKind] = useState<AssertionKind>('text-visible');
  const [value, setValue] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const problems = {
    name: /^[\w][\w .-]*$/.test(name) ? undefined : 'Use letters, digits, space, dot, dash or underscore',
    flowId: method === 'flow' && flowId.trim() === '' ? 'Shared step or flow name is required' : undefined,
    url: url.trim() === '' ? 'Validation page is required' : undefined,
    value: value.trim() === '' ? 'Assertion text is required' : undefined,
  };
  const valid = Object.values(problems).every((p) => p === undefined);
  const target = { environmentId: envId, name };

  const reset = () => {
    setPhase('form');
    setError(null);
    setTouched(false);
  };

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    setError(null);
    setPhase('starting');
    const validation = { url: url.trim(), assertion: { kind, value: value.trim() } };
    try {
      if (method === 'flow') {
        await utils.client.auth.saveFlow.mutate({ ...target, flowId: flowId.trim(), validation });
        await utils.auth.list.invalidate();
        onDone();
        reset();
        return;
      }
      await utils.client.auth.record.mutate({ ...target, validation });
      setPhase('recording');
    } catch (err) {
      setError(errorMessage(err));
      setPhase('form');
    }
  };

  const finish = async () => {
    setPhase('finishing');
    try {
      await utils.client.auth.finishRecording.mutate(target);
      await utils.auth.list.invalidate();
      onDone();
      reset();
    } catch (err) {
      setError(errorMessage(err));
      setPhase('recording');
    }
  };

  const busy = phase === 'starting' || phase === 'finishing';
  const err = (p: string | undefined) =>
    touched && p !== undefined ? (
      <span role="alert" className="text-danger">
        {p}
      </span>
    ) : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) {
          onOpenChange(o);
          if (!o) reset();
        }
      }}
      title="Record a login"
      description="Log in once; every run reuses the saved session. The validation check marks the session Expired when it stops working."
      footer={
        phase === 'recording' || phase === 'finishing' ? (
          <Button variant="primary" disabled={busy} onClick={() => void finish()}>
            {phase === 'finishing' ? 'Saving the session…' : 'Done'}
          </Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void submit()}>
              {phase === 'starting' ? 'Opening…' : method === 'record' ? 'Open browser' : 'Save flow'}
            </Button>
          </>
        )
      }
    >
      {error !== null && <Callout tone="danger">{error}</Callout>}
      {phase === 'form' || phase === 'starting' ? (
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="How">
            {(id) => (
              <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                <option value="record">Record in a browser</option>
                <option value="flow">Run a shared step</option>
              </Select>
            )}
          </Field>
          <Field label="Name" hint={err(problems.name)}>
            {(id) => <Input id={id} mono value={name} aria-invalid={touched && problems.name !== undefined} onChange={(e) => setName(e.target.value)} />}
          </Field>
          {method === 'flow' && (
            <Field label="Shared step or flow name" hint={err(problems.flowId)}>
              {(id) => <Input id={id} mono value={flowId} aria-invalid={touched && problems.flowId !== undefined} onChange={(e) => setFlowId(e.target.value)} />}
            </Field>
          )}
          <Field label="Validation page" hint={err(problems.url) ?? 'Opened with the saved session. A path resolves against the base URL.'}>
            {(id) => <Input id={id} mono value={url} aria-invalid={touched && problems.url !== undefined} onChange={(e) => setUrl(e.target.value)} />}
          </Field>
          <Field label="Validation check">
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as AssertionKind)}>
                {(Object.keys(ASSERTION_LABEL) as AssertionKind[]).map((k) => (
                  <option key={k} value={k}>
                    {ASSERTION_LABEL[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Check value" hint={err(problems.value)}>
            {(id) => <Input id={id} value={value} placeholder="Sign out" aria-invalid={touched && problems.value !== undefined} onChange={(e) => setValue(e.target.value)} />}
          </Field>
          <button type="submit" className="sr-only" tabIndex={-1}>
            Submit
          </button>
        </form>
      ) : (
        <Callout tone="info-ai">A browser window is open. Log in to your app there, then press Done.</Callout>
      )}
    </Dialog>
  );
}

/** Aside card listing saved logins with Record a login / Refresh now. */
export function LoginSetupCard({ envId }: { envId: string }) {
  const utils = trpc.useUtils();
  const list = trpc.auth.list.useQuery({ environmentId: envId });
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const refreshAll = async () => {
    setRefreshing(true);
    setResult(null);
    try {
      for (const s of list.data ?? []) await utils.client.auth.refresh.mutate({ id: s.id });
      await utils.auth.list.invalidate();
      setResult({ ok: true, text: 'Logins refreshed' });
    } catch (err) {
      setResult({ ok: false, text: errorMessage(err) });
      await utils.auth.list.invalidate();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Card aria-label="Login setup" className="flex flex-col gap-3 p-[18px] text-sm">
      <h2 className="text-[15px] font-semibold text-fg">Login setup</h2>
      {list.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : list.isError ? (
        <Callout tone="danger">Could not load logins: {errorMessage(list.error)}</Callout>
      ) : (list.data?.length ?? 0) === 0 ? (
        <p className="m-0 text-secondary">No saved login yet. Record one and every run reuses the session.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {(list.data ?? []).map((s) => (
            <li key={s.id} className="flex flex-col gap-1.5 rounded-control bg-surface-subtle p-3">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-mono text-[13px]">{s.name}</span>
                <StatusText status={s.status} />
              </div>
              <div className="text-xs text-strong-2">{meta(s)}</div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-[40px]" onClick={() => setOpen(true)}>
          Record a login
        </Button>
        <Button className="min-h-[40px]" disabled={refreshing || (list.data?.length ?? 0) === 0} onClick={() => void refreshAll()}>
          {refreshing ? 'Refreshing…' : 'Refresh now'}
        </Button>
      </div>
      {result !== null && (
        <span role={result.ok ? 'status' : 'alert'} className={result.ok ? 'text-sm font-medium text-success' : 'text-sm font-medium text-danger'}>
          {result.text}
        </span>
      )}
      <RecordLoginDialog envId={envId} open={open} onOpenChange={setOpen} onDone={() => setOpen(false)} />
    </Card>
  );
}
