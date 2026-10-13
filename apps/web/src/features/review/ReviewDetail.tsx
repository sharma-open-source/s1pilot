import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';

import { DraftDetail } from './DraftDetail';
import { approveAllLabel, BROWSER_LABEL, s2Line, shortRun, thresholdText } from './model';

import { ProbabilityBar } from '@/components/app/live';
import { DiffLine } from '@/components/app/review';
import { Button, buttonStyles, Callout, EmptyState, Field, Skeleton, Tag, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { useCan } from '@/lib/session';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type Detail = RouterOutputs['reviews']['get'];
type HealData = Extract<Detail, { kind: 'heal' }>;
type VerdictData = Extract<Detail, { kind: 'verdict' }>;

const SECTION = 'flex min-w-0 flex-[999_1_520px] flex-col gap-4 rounded-card border border-line bg-surface p-5';

/** Detail pane of the review queue: loads one item and renders the heal diff or the uncertain verdict. */
export function ReviewDetail({ id, tab, onDecided }: { id: string; tab?: string; onDecided: (nextId: string | null) => void }) {
  if (tab === 'drafts') return <DraftDetail id={id} onDecided={onDecided} />;
  return <ReviewItemDetail id={id} onDecided={onDecided} />;
}

function ReviewItemDetail({ id, onDecided }: { id: string; onDecided: (nextId: string | null) => void }) {
  const query = trpc.reviews.get.useQuery(id);
  if (query.isLoading) {
    return (
      <section aria-label="Review detail" className={SECTION}>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-16 w-full" />
      </section>
    );
  }
  if (query.isError || !query.data) {
    return (
      <section aria-label="Review detail" className="min-w-0 flex-[999_1_520px]">
        <Callout tone="danger">Could not load this item: {errorMessage(query.error)}</Callout>
      </section>
    );
  }
  return query.data.kind === 'heal' ? (
    <HealDetail data={query.data} onDecided={onDecided} />
  ) : (
    <VerdictDetailView data={query.data} onDecided={onDecided} />
  );
}

/* ---------------------------------------------------------------- shared decision form */

type Decision = 'approve' | 'approve-case-only' | 'reject';

/** Note field and decision buttons; decided items show their outcome instead. */
function DecisionForm({
  data,
  buttons,
  onDecided,
}: {
  data: Detail;
  buttons: Array<{
    label: string;
    decision: Decision;
    verdict?: 'passed' | 'failed';
    variant: 'success' | 'secondary' | 'danger-outline';
    title?: string;
    /** After the decision, open the Defects page with a prefilled new defect (S-054). */
    defect?: { search: Record<string, unknown> };
  }>;
  onDecided: (nextId: string | null) => void;
}) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const [note, setNote] = useState('');
  const [defectSearch, setDefectSearch] = useState<Record<string, unknown> | undefined>(undefined);
  const mutation = trpc.reviews.decide.useMutation({
    onSuccess: (out) => {
      void utils.reviews.counts.invalidate();
      void utils.reviews.list.invalidate();
      void utils.reviews.get.invalidate();
      void utils.runs.report.invalidate();
      void utils.results.get.invalidate();
      void utils.runs.list.invalidate();
      void utils.dashboard.invalidate();
      if (defectSearch) {
        void navigate({ to: `/p/${encodeURIComponent(data.projectKey)}/defects` as never, search: defectSearch as never });
        return;
      }
      onDecided(out.nextId);
    },
  });
  const canDecide = useCan('reviews:decide');
  const canApprove = useCan('approvals:decide');
  const item = data.item;
  if (item.status === 'pending' && !canDecide) {
    return <Callout tone="info-ai">Your role can view this item but not decide it.</Callout>;
  }
  if (item.status !== 'pending') {
    return (
      <div className="flex flex-col gap-2 border-t border-divider-row pt-3">
        <Callout tone={item.status === 'approved' ? 'success' : 'warning'}>
          {item.status === 'approved' ? 'Approved' : 'Rejected'}
          {item.resolvedAt ? ` on ${new Date(item.resolvedAt).toLocaleString()}` : ''}
          {item.note ? `. ${item.note}` : '.'}
        </Callout>
      </div>
    );
  }
  return (
    <>
      <Field label="Note (optional)">
        {(fid) => <Textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you approved or rejected" />}
      </Field>
      {mutation.isError && <Callout tone="danger">{errorMessage(mutation.error)}</Callout>}
      <div className="flex flex-wrap gap-2.5 border-t border-divider-row pt-3">
        {buttons.filter((b) => canApprove || item.kind !== 'heal' || b.decision === 'reject').map((b) => (
          <Button
            key={b.label}
            variant={b.variant === 'success' ? 'primary' : b.variant}
            className={cn(b.variant === 'success' && 'bg-success')}
            disabled={mutation.isPending}
            title={b.title}
            onClick={() => {
              setDefectSearch(b.defect?.search);
              mutation.mutate({ id: item.id, decision: b.decision, note, ...(b.verdict ? { verdict: b.verdict } : {}) });
            }}
          >
            {b.label}
          </Button>
        ))}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- heal proposal */

function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="text-xs uppercase tracking-[0.05em] text-muted">{children}</div>;
}

function Fact({ label, children, sub, className }: { label: string; children?: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-[1_1_200px] flex-col gap-1 rounded-control bg-surface-subtle p-3', className)}>
      <span className="text-xs text-muted">{label}</span>
      {children}
      {sub !== undefined && <span className="text-xs text-secondary">{sub}</span>}
    </div>
  );
}

/** Stand-in for a page capture: hatched box with the control's rendered label. */
function LabelChip({ label, tone }: { label: string | null; tone: 'before' | 'after' }) {
  return (
    <div className="hatch flex h-[150px] items-end rounded-control border border-line p-2.5">
      <span
        className={cn(
          'rounded-tag px-2.5 py-1.5 text-[13px]',
          tone === 'before' ? 'border-2 border-dashed border-muted bg-surface' : 'border-[3px] border-primary bg-primary-soft font-semibold text-primary-text',
        )}
      >
        {label ?? '(unlabelled)'}
      </span>
    </div>
  );
}

function HealDetail({ data, onDecided }: { data: HealData; onDecided: (nextId: string | null) => void }) {
  const title = data.beforeLabel && data.afterLabel && data.beforeLabel !== data.afterLabel ? `“${data.beforeLabel}” → “${data.afterLabel}”` : data.stepAction;
  const browser = BROWSER_LABEL[data.browser] ?? data.browser;
  return (
    <section aria-label="Proposal detail" className={SECTION}>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 break-words text-lg font-semibold">{title}</h2>
        <div className="text-[13px] text-secondary">
          Found in run <span className="font-mono">#{shortRun(data.runId)}</span> · {data.environment || 'unknown environment'} · {browser} · step “{data.stepAction}”
          <span className="text-muted"> · </span>
          <span className="font-mono">{data.caseKey}</span>
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
        <div className="flex flex-col gap-2">
          <Eyebrow>Before · learned script</Eyebrow>
          <LabelChip label={data.beforeLabel} tone="before" />
          {data.before.map((l, i) => (
            <DiffLine key={i} kind="removed">
              {l}
            </DiffLine>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <Eyebrow>After · proposed by S1</Eyebrow>
          <LabelChip label={data.afterLabel} tone="after" />
          {data.after.map((l, i) => (
            <DiffLine key={i} kind="added">
              {l}
            </DiffLine>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-sm">
        <Fact label="S1 confidence" sub={s2Line(data.s2Agreed, data.approvedLive)}>
          <span className="font-mono text-lg font-semibold">{data.confidence.toFixed(2)}</span>
        </Fact>
        <Fact
          label="Impact"
          sub={data.sharedStepName !== null ? 'via shared step · all environments' : `this case only · ${data.environment || 'this environment'}`}
        >
          <span className="text-lg font-semibold">
            {data.impactCount} {data.impactCount === 1 ? 'case' : 'cases'}
          </span>
        </Fact>
        <div className="flex flex-[1_1_200px] flex-col gap-1 rounded-control bg-warning-soft p-3">
          <span className="text-xs text-warning-strong">Is this a bug?</span>
          <span className="text-sm text-warning-ink">Renamed label may be intentional. If not, reject and file a defect.</span>
        </div>
      </div>

      <DecisionForm
        data={data}
        onDecided={onDecided}
        buttons={[
          { label: approveAllLabel(data.impactCount), decision: 'approve', variant: 'success' },
          { label: 'Approve for this case only', decision: 'approve-case-only', variant: 'secondary' },
          {
            label: 'Reject & create defect',
            decision: 'reject',
            variant: 'danger-outline',
            title: 'Rejects the proposal and opens a prefilled defect',
            defect: {
              search: data.resultId
                ? { fromResult: data.resultId, step: data.stepIndex }
                : { new: true, title: `${data.caseKey}: step ${data.stepNumber} locator changed`, source: data.caseKey },
            },
          },
        ]}
      />
    </section>
  );
}

/* ---------------------------------------------------------------- uncertain verdict */

const A_VERDICT: Record<string, { label: string; cls: string }> = {
  pass: { label: 'passed', cls: 'text-success' },
  fail: { label: 'failed', cls: 'text-danger' },
  'needs-review': { label: 'needs review', cls: 'text-warning' },
};

function VerdictDetailView({ data, onDecided }: { data: VerdictData; onDecided: (nextId: string | null) => void }) {
  const browser = BROWSER_LABEL[data.browser] ?? data.browser;
  return (
    <section aria-label="Verdict detail" className={SECTION}>
      <div className="flex flex-wrap items-start justify-between gap-2.5">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="m-0 break-words text-lg font-semibold">
            <span className="font-mono">{data.caseKey}</span> · {data.caseTitle}
          </h2>
          <div className="text-[13px] text-secondary">
            Found in run <span className="font-mono">#{shortRun(data.runId)}</span> · {data.environment || 'unknown environment'} · {browser}
            {data.stepNumber !== null ? ` · step ${data.stepNumber}` : ''}
          </div>
        </div>
        <Link
          to={`/p/${encodeURIComponent(data.projectKey)}/runs/${encodeURIComponent(data.runId)}` as never}
          search={{ result: data.resultId } as never}
          className={buttonStyles({ variant: 'secondary', size: 'sm' })}
        >
          Open in run report
        </Link>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
        <div className="flex flex-col gap-1.5 rounded-control bg-surface-subtle p-3">
          <Eyebrow>Expected</Eyebrow>
          <span className="break-words text-sm">{data.expected ?? 'No expected text was recorded for this step.'}</span>
        </div>
        <div className="flex flex-col gap-2">
          <Eyebrow>Screenshot after step</Eyebrow>
          {data.screenshotId ? (
            <img
              src={`/api/artifacts/${encodeURIComponent(data.screenshotId)}`}
              alt={`Screenshot after step ${data.stepNumber ?? ''}`}
              className="max-h-64 w-full rounded-control border border-line object-contain object-top"
            />
          ) : (
            <EmptyState>No screenshot was captured for this step.</EmptyState>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-control bg-surface-subtle p-3">
        <Eyebrow>AI check · {data.model ?? 'model unknown'}</Eyebrow>
        {data.pTrue !== null ? (
          <ProbabilityBar label="P(expected result is true)" value={data.pTrue} top />
        ) : (
          <span className="text-sm text-secondary">No probability was recorded for this result.</span>
        )}
        <span className="text-xs text-secondary">{thresholdText(data.thresholds)}</span>
      </div>

      {data.assertions.length > 0 && (
        <ul aria-label="Assertions" className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {data.assertions.map((a, i) => {
            const v = A_VERDICT[a.verdict] ?? { label: a.verdict, cls: '' };
            return (
              <li key={i} className="flex flex-wrap items-center gap-2.5 rounded-control border border-divider px-3 py-2.5">
                <Tag tone={a.assertion === 'ai' ? 'ai' : 'neutral'} mono={a.assertion !== 'ai'}>
                  {a.assertion === 'ai' ? 'AI check' : a.assertion}
                </Tag>
                {a.probability !== null && <span className="font-mono">{a.probability.toFixed(2)}</span>}
                <span className={cn('font-semibold', v.cls)}>{v.label}</span>
                {a.message && <span className="text-secondary">{a.message}</span>}
                <span className="text-xs text-muted">step {a.stepNumber}</span>
              </li>
            );
          })}
        </ul>
      )}

      <DecisionForm
        data={data}
        onDecided={onDecided}
        buttons={[
          { label: 'Mark passed', decision: 'approve', verdict: 'passed', variant: 'success' },
          { label: 'Mark failed', decision: 'reject', verdict: 'failed', variant: 'danger-outline' },
        ]}
      />
    </section>
  );
}
