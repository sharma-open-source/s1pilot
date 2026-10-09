import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  currentStepIndex,
  formatTimer,
  preRunLabel,
  queueStatusKey,
  VERDICTS,
  verdictPillLabel,
  verdictTone,
  type StepVerdict,
} from './model';

import { Breadcrumb, Button, Callout, EmptyState, LinkButton, Pill, Skeleton, StatusPill, Textarea } from '@/components/ui';
import { BROWSER_LABEL } from '@/features/review/model';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type View = RouterOutputs['manual']['get'];
type StepView = View['steps'][number];

const CARD = 'flex flex-col gap-2.5 rounded-card border bg-surface px-[18px] py-4';

interface ManualRunPageProps {
  projectKey: string;
  /** Manual item (session item) id from the route. */
  sessionId: string;
  onOpenItem: (id: string) => void;
  onBackToQueue: () => void;
}

/** Manual / hybrid execution of one case (`/p/:key/manual/:sessionId`). */
export function ManualRunPage({ projectKey, sessionId, onOpenItem, onBackToQueue }: ManualRunPageProps) {
  const utils = trpc.useUtils();
  const query = trpc.manual.get.useQuery({ itemId: sessionId });
  const refresh = () => {
    void utils.manual.get.invalidate();
    void utils.manual.myQueue.invalidate();
  };
  const start = trpc.manual.start.useMutation({ onSuccess: refresh });
  const view = query.data;
  const open = view !== undefined && (view.item.status === 'todo' || view.item.status === 'in-progress');
  const startedFor = useRef<string | undefined>(undefined);
  // Opening an item starts it, and its timer when it is not running.
  useEffect(() => {
    if (view && open && !view.timerRunning && startedFor.current !== view.item.id) {
      startedFor.current = view.item.id;
      start.mutate({ itemId: view.item.id });
    }
  }, [view?.item.id, open, view?.timerRunning]);

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <h1 className="text-[24px] font-semibold text-fg">Manual run</h1>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (query.isError || !view) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-[24px] font-semibold text-fg">Manual run</h1>
        <Callout tone="danger">Could not load this manual session: {errorMessage(query.error)}</Callout>
      </div>
    );
  }
  return <Session key={view.item.id} view={view} fetchedAt={query.dataUpdatedAt} projectKey={projectKey} refresh={refresh} onOpenItem={onOpenItem} onBackToQueue={onBackToQueue} />;
}

interface SessionProps {
  view: View;
  fetchedAt: number;
  projectKey: string;
  refresh: () => void;
  onOpenItem: (id: string) => void;
  onBackToQueue: () => void;
}

function Session({ view, fetchedAt, projectKey, refresh, onOpenItem, onBackToQueue }: SessionProps) {
  const { item } = view;
  const open = item.status === 'todo' || item.status === 'in-progress';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!view.timerRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [view.timerRunning]);
  const elapsed = view.elapsedMs + (view.timerRunning ? Math.max(0, now - fetchedAt) : 0);

  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [redo, setRedo] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | undefined>(undefined);
  const current = open ? currentStepIndex(view.steps, redo, selected) : undefined;

  const finish = trpc.manual.finish.useMutation({
    onSuccess: (r) => {
      refresh();
      if (r.nextItemId) onOpenItem(r.nextItemId);
      else onBackToQueue();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const skip = trpc.manual.skip.useMutation({
    onSuccess: (r) => {
      refresh();
      if (r.nextItemId) onOpenItem(r.nextItemId);
      else onBackToQueue();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const aiSteps = view.steps.filter((s) => s.preRun != null);
  const aiPassed = aiSteps.length > 0 && aiSteps.every((s) => s.preRun === 'passed');
  const browserLabel = view.browser ? (BROWSER_LABEL[view.browser] ?? view.browser) : null;
  const where = [view.environment, [browserLabel, view.device].filter(Boolean).join(' · ') || null].filter(Boolean).join(' · ');

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Breadcrumb
            items={[
              { label: 'Manual testing', to: `/p/${projectKey}/manual` },
              {
                label: `${view.buildRef ? `Build ${view.buildRef.slice(0, 7)}` : `Run ${item.runId.slice(0, 6)}`} · assigned to you · case ${view.position} of ${view.total}`,
              },
            ]}
          />
          <h1 className="text-[24px] font-semibold text-fg">
            <span className="font-mono">{view.caseKey}</span> · {view.title}
          </h1>
          <div className="text-[13px] text-strong-2">
            {where}
            {where !== '' && ' · '}timer{' '}
            <span className="font-mono" role="timer" aria-label="Elapsed time">
              {formatTimer(elapsed)}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Button disabled={view.previousId === null} onClick={() => view.previousId && onOpenItem(view.previousId)}>
            Previous case
          </Button>
          <Button disabled={!open || skip.isPending} onClick={() => skip.mutate({ itemId: item.id })}>
            Skip
          </Button>
          <Button variant="ink" disabled={!open || finish.isPending} onClick={() => finish.mutate({ itemId: item.id })}>
            Finish &amp; next case
          </Button>
        </div>
      </header>

      {error !== undefined && <Callout tone="danger">{error}</Callout>}
      {!open && (
        <Callout tone="success">
          This case was {item.status === 'skipped' ? 'skipped' : 'finished'}.{' '}
          {view.nextId ? (
            <button type="button" className="underline" onClick={() => onOpenItem(view.nextId as string)}>
              Open the next case
            </button>
          ) : (
            <Link to={`/p/${projectKey}/manual` as never} className="underline">
              Back to the queue
            </Link>
          )}
        </Callout>
      )}
      {item.hybrid && (
        <Callout tone="info-ai" className="px-4 py-3 text-sm">
          {aiSteps.length === 0
            ? `Hybrid mode: the AI pre-run on ${browserLabel ?? 'Chromium'} has no results yet. Run the steps yourself or reload when it finishes.`
            : `Hybrid mode: S1 pre-ran steps ${rangeLabel(aiSteps.map((s) => s.index + 1))} on ${browserLabel ?? 'Chromium'}${aiPassed ? ' and passed them' : ''}. Confirm or redo them on this device.`}
        </Callout>
      )}

      <div className="flex flex-wrap items-start gap-5">
        <section aria-label="Steps" className="flex min-w-0 flex-[999_1_600px] flex-col gap-3">
          {view.steps.map((s) => (
            <StepCard
              key={s.index}
              step={s}
              itemId={item.id}
              editable={open}
              isCurrent={current === s.index}
              redo={redo.has(s.index)}
              projectKey={projectKey}
              onRedo={() => setRedo((r) => new Set(r).add(s.index))}
              onSelect={() => setSelected(s.index)}
              onRecorded={() => {
                setSelected(undefined);
                setError(undefined);
                refresh();
              }}
              refresh={refresh}
            />
          ))}
        </section>
        <Aside view={view} projectKey={projectKey} onOpenItem={onOpenItem} />
      </div>
    </div>
  );
}

/** `1–2`, `1, 3`, `4` */
function rangeLabel(nums: number[]): string {
  if (nums.length === 0) return '';
  const consecutive = nums.every((n, i) => i === 0 || n === (nums[i - 1] as number) + 1);
  return nums.length > 1 && consecutive ? `${nums[0]}–${nums[nums.length - 1]}` : nums.join(', ');
}

/* ------------------------------------------------------------------ steps */

interface StepCardProps {
  step: StepView;
  itemId: string;
  editable: boolean;
  isCurrent: boolean;
  redo: boolean;
  projectKey: string;
  onRedo: () => void;
  onSelect: () => void;
  onRecorded: () => void;
  refresh: () => void;
}

function StepCard({ step, itemId, editable, isCurrent, redo, projectKey, onRedo, onSelect, onRecorded, refresh }: StepCardProps) {
  const heading = (
    <div>
      <span className="font-mono text-secondary">{step.index + 1}</span> · {isCurrent ? <strong>{step.action}</strong> : step.action}
      {step.expected && <div className="text-[13px] text-strong-2">Expected: {step.expected}</div>}
    </div>
  );

  if (isCurrent) return <CurrentStep step={step} heading={heading} itemId={itemId} projectKey={projectKey} onKeep={onSelect} onRecorded={onRecorded} refresh={refresh} />;

  if (step.verdict !== null) {
    const v = step.verdict as StepVerdict;
    return (
      <article className={cn(CARD, 'border-line')} aria-label={`Step ${step.index + 1}`}>
        <div className="flex flex-wrap justify-between gap-3">
          {heading}
          <div className="flex items-center gap-2">
            <Pill tone={verdictTone(v)} className="self-start">
              {`${verdictPillLabel(v)}${step.confirmed ? ' · confirmed' : ''}`}
            </Pill>
            {editable && (
              <Button size="sm" onClick={onSelect} aria-label={`Edit step ${step.index + 1}`}>
                Edit
              </Button>
            )}
          </div>
        </div>
        {step.actual && <div className="text-[13px] text-strong-2">Actual: {step.actual}</div>}
      </article>
    );
  }

  if (step.preRun !== null && !redo && editable) {
    return <PreRunStep step={step} heading={heading} itemId={itemId} onRedo={onRedo} refresh={refresh} />;
  }

  return (
    <article className={cn(CARD, 'border-line-soft text-strong-2')} aria-label={`Step ${step.index + 1}`}>
      <div className="flex flex-wrap justify-between gap-3">
        {heading}
        {editable && (
          <Button size="sm" onClick={onSelect} aria-label={`Start step ${step.index + 1}`}>
            Start here
          </Button>
        )}
      </div>
    </article>
  );
}

function PreRunStep({ step, heading, itemId, onRedo, refresh }: { step: StepView; heading: ReactNode; itemId: string; onRedo: () => void; refresh: () => void }) {
  const [error, setError] = useState<string | undefined>(undefined);
  const confirm = trpc.manual.confirmPreRun.useMutation({ onSuccess: refresh, onError: (e) => setError(errorMessage(e)) });
  return (
    <article className={cn(CARD, 'border-line')} aria-label={`Step ${step.index + 1}`}>
      <div className="flex flex-wrap justify-between gap-3">
        {heading}
        <Pill tone="warning" className="self-start">
          AI pre-run: {preRunLabel(step.preRun as string)} · confirm?
        </Pill>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={confirm.isPending} onClick={() => confirm.mutate({ itemId, stepIndex: step.index })}>
          Confirm
        </Button>
        <Button size="sm" onClick={onRedo}>
          Redo
        </Button>
      </div>
      {error !== undefined && <Callout tone="danger">{error}</Callout>}
    </article>
  );
}

function CurrentStep({
  step,
  heading,
  itemId,
  projectKey,
  onKeep,
  onRecorded,
  refresh,
}: {
  step: StepView;
  heading: ReactNode;
  itemId: string;
  projectKey: string;
  /** Keeps this step open after a verdict was recorded (so the actual result can be written). */
  onKeep: () => void;
  onRecorded: () => void;
  refresh: () => void;
}) {
  const [actual, setActual] = useState(step.actual);
  const [verdict, setVerdict] = useState<StepVerdict | null>(step.verdict as StepVerdict | null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const record = trpc.manual.recordStep.useMutation({ onError: (e) => setError(errorMessage(e)) });

  const save = (v: StepVerdict, advance: boolean) =>
    record.mutate(
      { itemId, stepIndex: step.index, verdict: v, actual },
      { onSuccess: () => (advance ? onRecorded() : refresh()) },
    );

  const upload = async (file: File) => {
    setUploading(true);
    setError(undefined);
    try {
      const res = await fetch(`/api/manual/${encodeURIComponent(itemId)}/attachments?step=${step.index}&name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Upload failed (${res.status})`);
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <article className="flex flex-col gap-3 rounded-card border-2 border-primary bg-surface px-[18px] py-4" aria-label={`Step ${step.index + 1}`} aria-current="step">
      {heading}
      <div role="group" aria-label={`Step ${step.index + 1} result`} className="flex flex-wrap gap-2">
        {VERDICTS.map(([id, label]) => {
          const pressed = verdict === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={pressed}
              disabled={record.isPending}
              onClick={() => {
                setVerdict(id);
                onKeep();
                save(id, false);
              }}
              className={cn(
                'min-h-[44px] rounded-control px-[18px] text-sm',
                pressed
                  ? id === 'fail'
                    ? 'border-0 bg-danger font-semibold text-white'
                    : 'border-0 bg-ink font-semibold text-white'
                  : id === 'pass'
                    ? 'border border-success bg-surface font-semibold text-success'
                    : 'border border-line-input bg-surface font-medium text-fg',
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
      <label className="flex flex-col gap-1.5 text-[13px] font-medium">
        Actual result
        <Textarea
          rows={3}
          value={actual}
          onChange={(e) => setActual(e.target.value)}
          onBlur={() => verdict !== null && actual !== step.actual && save(verdict, false)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2.5">
        {step.attachments.map((a) =>
          a.kind === 'video' ? (
            <video key={a.id} src={a.url} controls className="h-20 w-[120px] rounded-tag border border-line object-cover" aria-label={`Attached video ${a.name}`} />
          ) : (
            <a key={a.id} href={a.url} target="_blank" rel="noreferrer">
              <img src={a.url} alt={`Attached screenshot ${a.name}`} className="h-20 w-[120px] rounded-tag border border-line object-cover" />
            </a>
          ),
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          hidden
          aria-label="Attachment file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void upload(f);
          }}
        />
        <Button variant="dashed" disabled={uploading} onClick={() => fileRef.current?.click()}>
          + Attach screenshot or video
        </Button>
        <Button variant="secondary" size="sm" disabled={verdict === null || record.isPending} onClick={() => verdict !== null && save(verdict, true)}>
          Save &amp; next step
        </Button>
        <LinkButton
          variant="danger-outline"
          size="sm"
          to={`/p/${projectKey}/defects`}
          search={{ fromManual: itemId, step: step.index }}
        >
          Create defect from this step
        </LinkButton>
      </div>
      {error !== undefined && <Callout tone="danger">{error}</Callout>}
    </article>
  );
}

/* ------------------------------------------------------------------ aside */

function Aside({ view, projectKey, onOpenItem }: { view: View; projectKey: string; onOpenItem: (id: string) => void }) {
  const utils = trpc.useUtils();
  const [notes, setNotes] = useState(view.item.notes);
  const [created, setCreated] = useState<{ key: string; structured: boolean } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const save = trpc.manual.notes.update.useMutation({ onError: (e) => setError(errorMessage(e)) });
  const toDraft = trpc.manual.noteToDraft.useMutation({
    onSuccess: (r) => {
      setCreated(r);
      void utils.cases.list.invalidate();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <aside className="flex min-w-0 flex-[1_1_280px] flex-col gap-4">
      <section aria-label="Session" className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-[18px] text-sm">
        <h2 className="text-[15px] font-semibold">My queue</h2>
        {view.queue.length === 0 ? (
          <EmptyState>Nothing is assigned to you.</EmptyState>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {view.queue.map((q) => (
              <li key={q.id} className={cn('flex items-center justify-between gap-2', q.id === view.item.id && 'font-semibold')}>
                <button
                  type="button"
                  className="min-h-[44px] text-left font-mono text-sm text-fg hover:underline"
                  aria-current={q.id === view.item.id ? 'true' : undefined}
                  onClick={() => onOpenItem(q.id)}
                >
                  {q.caseKey}
                </button>
                <StatusPill status={q.id === view.item.id && q.status !== 'done' && q.status !== 'skipped' ? 'in-progress' : queueStatusKey(q.status, q.verdict)} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Notes" className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-[18px] text-sm">
        <h2 className="text-[15px] font-semibold">Session notes</h2>
        <Textarea
          rows={5}
          aria-label="Session notes"
          placeholder="Observations, ideas for new tests"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== view.item.notes && save.mutate({ itemId: view.item.id, notes })}
        />
        <Button
          size="sm"
          className="self-start"
          disabled={notes.trim() === '' || toDraft.isPending}
          onClick={() => toDraft.mutate({ itemId: view.item.id, note: notes })}
        >
          Turn note into test case draft
        </Button>
        {created && (
          <Callout tone="success">
            Created draft{' '}
            <Link to={`/p/${projectKey}/cases/${created.key}` as never} className="font-mono underline">
              {created.key}
            </Link>
            {created.structured ? ' with steps from System 2.' : ' with one step.'}
          </Callout>
        )}
        {error !== undefined && <Callout tone="danger">{error}</Callout>}
      </section>
    </aside>
  );
}
