import { useEffect, useMemo, useState } from 'react';

import { Button, Callout, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { trpc, untypedClient, type RouterOutputs } from '@/lib/trpc';

type Draft = NonNullable<RouterOutputs['recorder']['stop']['draft']>;
type SaveResult = RouterOutputs['recorder']['save'];

/** One step in the review list (editable). */
interface ReviewStep {
  id: string;
  action: string;
  expected: string;
}

export interface RecorderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectKey: string;
  /** Insert into this case; without it a new draft case is created. */
  caseKey?: string;
  /** Step index to insert at (case editor: the end). */
  fromStep?: number;
  /** Suite of the new draft case. */
  suiteId?: string;
  /** Called after the steps were saved. */
  onSaved: (result: SaveResult) => void;
  /** How often the live step list refreshes while recording. Default 1000 ms. */
  pollMs?: number;
}

type Phase = 'setup' | 'recording' | 'review' | 'saving';

/**
 * Recording panel (S-060): choose the environment and start a headed browser, watch the captured steps
 * live (Pause, Add expected result, Stop), then review and edit the text, variables and secrets before saving.
 */
export function RecorderDialog({ open, onOpenChange, projectKey, caseKey, fromStep, suiteId, onSaved, pollMs = 1000 }: RecorderDialogProps) {
  const envs = trpc.environments.list.useQuery({ projectKey }, { enabled: open });
  const [envId, setEnvId] = useState('');
  const [phase, setPhase] = useState<Phase>('setup');
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expectation, setExpectation] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [review, setReview] = useState<ReviewStep[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const start = trpc.recorder.start.useMutation();
  const pause = trpc.recorder.pause.useMutation();
  const resume = trpc.recorder.resume.useMutation();
  const addExpectation = trpc.recorder.addExpectation.useMutation();
  const stop = trpc.recorder.stop.useMutation();
  const cancel = trpc.recorder.cancel.useMutation();

  const list = envs.data ?? [];
  useEffect(() => {
    if (envId === '' && list[0] !== undefined) setEnvId(list[0].id);
  }, [envId, list]);

  // Reset when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setPhase('setup');
    setSessionId('');
    setError(null);
    setDraft(null);
    setReview([]);
    setValues({});
    setTitle('');
    setNotice(null);
    setExpectation('');
  }, [open]);

  const status = trpc.recorder.status.useQuery(
    { sessionId },
    { enabled: open && phase === 'recording' && sessionId !== '', refetchInterval: pollMs, retry: false },
  );
  const live = status.data;

  const toReview = (d: Draft) => {
    setDraft(d);
    setReview(d.steps.map((s) => ({ id: s.id, action: s.action, expected: s.expected ?? '' })));
    setPhase('review');
  };

  const doStop = async () => {
    setError(null);
    try {
      const result = await stop.mutateAsync({ sessionId });
      if (result.draft) toReview(result.draft);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  // The user pressed Stop in the browser toolbar (or closed the window).
  const stoppedInBrowser = live?.state === 'stopped';
  useEffect(() => {
    if (phase === 'recording' && stoppedInBrowser) void doStop();
  }, [phase, stoppedInBrowser]);

  const begin = async () => {
    setError(null);
    try {
      const s = await start.mutateAsync({
        projectKey,
        environmentId: envId,
        ...(caseKey !== undefined ? { caseKey } : {}),
        ...(fromStep !== undefined ? { fromStep } : {}),
        ...(suiteId !== undefined ? { suiteId } : {}),
      });
      setSessionId(s.sessionId);
      setPhase('recording');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const close = async () => {
    if (sessionId !== '' && phase !== 'setup') await cancel.mutateAsync({ sessionId }).catch(() => undefined);
    onOpenChange(false);
  };

  const used = useMemo(() => {
    const keys = new Set(
      review.flatMap((r) => draft?.steps.find((s) => s.id === r.id)?.actions.flatMap((a) => (a.valueRef ? [a.valueRef.slice(a.valueRef.indexOf(':') + 1)] : [])) ?? []),
    );
    return (draft?.variables ?? []).filter((v) => keys.has(v.key));
  }, [draft, review]);

  const save = async () => {
    setPhase('saving');
    setError(null);
    try {
      // Called without the mutation cache so a typed secret never lands in client state beyond this form.
      const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
      const result = (await untypedClient.mutation('recorder.save', {
        sessionId,
        steps: review.map((r) => ({ id: r.id, action: r.action, ...(r.expected.trim() !== '' ? { expected: r.expected } : {}) })),
        ...(Object.keys(filled).length > 0 ? { variables: filled } : {}),
        ...(caseKey === undefined && title.trim() !== '' ? { title: title.trim() } : {}),
      })) as SaveResult;
      setValues({});
      if (result.missingSecrets.length > 0) {
        setNotice(`Saved. Add a value for ${result.missingSecrets.join(', ')} under Environments before running.`);
      }
      onSaved(result);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
      setPhase('review');
    }
  };

  const setReviewField = (id: string, patch: Partial<ReviewStep>) => setReview((r) => r.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const running = phase === 'recording';
  const paused = live?.state === 'paused';

  let body;
  let footer;
  if (phase === 'setup') {
    body = (
      <div className="flex flex-col gap-3.5">
        <p className="m-0 text-sm text-secondary">
          A Chromium window opens on the machine running s1-pilot. Click through your app; each action is captured as a step and as a learned script, so the next run replays it without a model.
        </p>
        {fromStep !== undefined && fromStep > 0 && (
          <Callout tone="info-ai">Recording starts paused. Go to the page where the new steps begin, then press Resume in the toolbar.</Callout>
        )}
        {envs.isError && <Callout tone="danger">Could not load environments: {errorMessage(envs.error)}</Callout>}
        {envs.isSuccess && list.length === 0 && <Callout tone="warning">This project has no environments yet. Add one under Environments first.</Callout>}
        <Field label="Environment">
          {(id) => (
            <Select id={id} value={envId} onChange={(e) => setEnvId(e.target.value)} disabled={list.length === 0}>
              {list.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {error !== null && <Callout tone="danger">{error}</Callout>}
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={start.isPending || envId === ''} onClick={() => void begin()}>
          {start.isPending ? 'Opening browser…' : 'Start recording'}
        </Button>
      </>
    );
  } else if (running) {
    body = (
      <div className="flex flex-col gap-3.5">
        <p role="status" className="m-0 flex items-center gap-2 text-sm text-fg">
          <span aria-hidden="true" className={paused ? 'inline-block size-2.5 rounded-full bg-warning-strong' : 'inline-block size-2.5 rounded-full bg-danger-strong'} />
          {paused ? 'Paused. Actions are not captured.' : 'Recording in the browser window.'}
        </p>
        <section aria-label="Captured steps" className="flex flex-col gap-2">
          {live === undefined || live.steps.length === 0 ? (
            <p className="m-0 text-sm text-secondary">No steps yet. Click, type or select something in the browser window.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {live.steps.map((s, i) => (
                <li key={s.id} className="rounded-control border border-line px-3 py-2 text-sm">
                  <span className="font-mono text-secondary">{i + 1}. </span>
                  {s.action}
                  {s.expected !== undefined && <div className="text-[13px] text-secondary">Expected: {s.expected}</div>}
                </li>
              ))}
            </ol>
          )}
        </section>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const text = expectation.trim();
            if (text === '') return;
            void addExpectation.mutateAsync({ sessionId, text }).then(
              () => setExpectation(''),
              (err: unknown) => setError(errorMessage(err)),
            );
          }}
        >
          <Field label="Expected result" className="min-w-[200px] flex-1">
            {(id) => <Input id={id} value={expectation} onChange={(e) => setExpectation(e.target.value)} placeholder="e.g. The cart shows 1 item" />}
          </Field>
          <Button type="submit" variant="secondary" disabled={expectation.trim() === '' || addExpectation.isPending}>
            Add expected result
          </Button>
        </form>
        {error !== null && <Callout tone="danger">{error}</Callout>}
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={() => void close()}>
          Cancel recording
        </Button>
        <Button
          variant="secondary"
          disabled={pause.isPending || resume.isPending}
          onClick={() => void (paused ? resume : pause).mutateAsync({ sessionId }).then(() => status.refetch(), (err: unknown) => setError(errorMessage(err)))}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button variant="primary" disabled={stop.isPending} onClick={() => void doStop()}>
          {stop.isPending ? 'Stopping…' : 'Stop'}
        </Button>
      </>
    );
  } else {
    const saving = phase === 'saving';
    body = (
      <div className="flex flex-col gap-3.5">
        {draft?.textSource === 'template' && (
          <p className="m-0 text-[13px] text-secondary">Step text was written from templates (no System 2 model configured). Edit it before saving.</p>
        )}
        {review.length === 0 && <Callout tone="warning">Nothing was recorded. Cancel, or go back and record some actions.</Callout>}
        {caseKey === undefined && (
          <Field label="Test case title">{(id) => <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Recorded test" />}</Field>
        )}
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {review.map((s, i) => (
            <li key={s.id} className="flex flex-col gap-2 rounded-control border border-line p-3">
              <Field label={`Step ${i + 1} action`}>
                {(id) => <Textarea id={id} rows={2} value={s.action} onChange={(e) => setReviewField(s.id, { action: e.target.value })} className="min-h-[64px]" />}
              </Field>
              <Field label={`Step ${i + 1} expected result`}>
                {(id) => <Input id={id} value={s.expected} onChange={(e) => setReviewField(s.id, { expected: e.target.value })} placeholder="Optional" />}
              </Field>
              <div>
                <Button variant="secondary" onClick={() => setReview((r) => r.filter((x) => x.id !== s.id))}>
                  {`Remove step ${i + 1}`}
                </Button>
              </div>
            </li>
          ))}
        </ol>
        {used.length > 0 && (
          <section aria-label="Test data" className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold text-fg">Test data</h3>
            <p className="m-0 text-[13px] text-secondary">
              Typed values become environment variables so steps never contain them. Passwords are never captured: enter the value now, or leave it empty and add it under Environments.
            </p>
            {used.map((v) =>
              v.secret ? (
                <Field key={v.key} label={`Secret ${v.key}`} hint={`Field: ${v.field}. Stored encrypted as secret:${v.key}.`}>
                  {(id) => (
                    <Input
                      id={id}
                      type="password"
                      autoComplete="off"
                      value={values[v.key] ?? ''}
                      onChange={(e) => setValues((x) => ({ ...x, [v.key]: e.target.value }))}
                    />
                  )}
                </Field>
              ) : (
                <Field key={v.key} label={`Variable ${v.key}`} hint={`Field: ${v.field}.`}>
                  {(id) => <Input id={id} mono value={values[v.key] ?? v.value ?? ''} onChange={(e) => setValues((x) => ({ ...x, [v.key]: e.target.value }))} />}
                </Field>
              ),
            )}
          </section>
        )}
        {notice !== null && <Callout tone="success">{notice}</Callout>}
        {error !== null && <Callout tone="danger">{error}</Callout>}
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" disabled={saving} onClick={() => void close()}>
          Discard
        </Button>
        <Button variant="primary" disabled={saving || review.length === 0 || review.some((r) => r.action.trim() === '')} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save steps'}
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open={open}
      // Only the explicit buttons close the dialog once a browser is open, so a stray click cannot lose a recording.
      onOpenChange={(o) => {
        if (!o && phase === 'setup') onOpenChange(false);
      }}
      title={phase === 'review' || phase === 'saving' ? 'Review recorded steps' : 'Record in browser'}
      description={caseKey !== undefined ? `Steps are added to ${caseKey}.` : 'A new draft test case is created from the recording.'}
      wide
      footer={footer}
    >
      {body}
    </Dialog>
  );
}
