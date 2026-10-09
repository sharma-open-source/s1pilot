import { useState } from 'react';

import { detailTitle, formatMs, OVERRIDE_VERDICTS } from './model';

import { ProbabilityBar } from '@/components/app/live';
import { ExpectedActual, ScreenshotTimeline, type TimelineStep } from '@/components/app/report';
import { Button, Callout, Dialog, Field, LinkButton, Select, Skeleton, Tag, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { trpc, type RouterOutputs } from '@/lib/trpc';

type ResultDetailData = RouterOutputs['results']['get'];
type DetailStep = ResultDetailData['steps'][number];
type CheckResultData = ResultDetailData['checks'][number];
type EvidenceTab = 'decisions' | 'video' | 'trace' | 'console' | 'network' | 'a11y';

const artifactUrl = (id: string): string => `/api/artifacts/${encodeURIComponent(id)}`;

const VERDICT_TEXT: Record<string, { label: string; cls: string }> = {
  pass: { label: 'passed', cls: 'text-success' },
  fail: { label: 'failed', cls: 'text-danger' },
  'needs-review': { label: 'needs review', cls: 'text-warning' },
};

function stepSuffix(s: DetailStep): string {
  if (s.status === 'passed') return `✓${s.mode ? ` ${s.mode}` : ''}`;
  if (s.status === 'failed') return '✗';
  if (s.status === 'blocked') return '✗ blocked';
  return 'skipped';
}

/** Detail card of one case result: header actions, expected/actual, assertions, screenshots and evidence tabs. */
export function ResultDetail({ resultId, projectKey, onChanged }: { resultId: string; projectKey: string; onChanged: () => void }) {
  const query = trpc.results.get.useQuery(resultId);
  const [overrideOpen, setOverrideOpen] = useState(false);

  if (query.isLoading) {
    return (
      <section aria-label="Result detail" className="flex min-w-0 flex-[999_1_520px] flex-col gap-4 rounded-card border border-line bg-surface p-5">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
      </section>
    );
  }
  if (query.isError || !query.data) {
    return (
      <section aria-label="Result detail" className="min-w-0 flex-[999_1_520px]">
        <Callout tone="danger">Could not load this result: {errorMessage(query.error)}</Callout>
      </section>
    );
  }
  const d = query.data;
  const verdict = d.result.verdict;
  const browser = d.result.browser ?? 'chromium';
  const failStep = d.steps.find((s) => s.status === 'failed' || s.status === 'blocked');
  const shownStep = failStep;
  const assertions = (shownStep ? [shownStep] : d.steps).flatMap((s) => s.assertions.map((a) => ({ a, step: s })));
  const failingAssertion = failStep?.assertions.find((a) => a.verdict !== 'pass');
  const expected = failStep?.expected ?? failingAssertion?.assertion;
  const actual = failingAssertion?.message ?? failStep?.actionTaken ?? (failStep ? `Step ${failStep.stepIndex + 1} ${failStep.status}` : undefined);

  const timeline: TimelineStep[] = [
    ...d.steps.map((s): TimelineStep => ({
      index: s.stepIndex,
      title: s.action || `Step ${s.stepIndex + 1}`,
      suffix: stepSuffix(s),
      state: s.status === 'passed' ? 'passed' : s.status === 'skipped' ? 'not-run' : 'failed',
      ...(s.screenshotId ? { src: artifactUrl(s.screenshotId) } : {}),
    })),
    ...d.notRun.map((s): TimelineStep => ({ index: s.index, title: s.action, suffix: 'not run', state: 'not-run' })),
  ].sort((x, y) => x.index - y.index);

  return (
    <section aria-label="Result detail" className="flex min-w-0 flex-[999_1_520px] flex-col gap-4 rounded-card border border-line bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <h2 className="m-0 min-w-0 break-words text-lg font-semibold">{detailTitle(d.case.key, browser, verdict, d.failedStep)}</h2>
        <div className="flex flex-wrap gap-2">
          <LinkButton
            variant="primary"
            className="bg-danger"
            to={`/p/${encodeURIComponent(projectKey)}/defects`}
            search={{ fromResult: resultId, ...(failStep ? { step: failStep.stepIndex } : {}) }}
          >
            Create defect
          </LinkButton>
          <Button onClick={() => setOverrideOpen(true)}>Override verdict</Button>
          <LinkButton to={`/p/${encodeURIComponent(projectKey)}/cases/${encodeURIComponent(d.case.key)}`}>Edit case</LinkButton>
        </div>
      </div>

      {d.overrides.length > 0 && (
        <Callout tone="info-ai">
          Verdict overridden: {d.overrides.at(-1)?.note ?? ''}
        </Callout>
      )}

      {d.checks.some((c) => c.severity === 'warn') && (
        <Callout tone="warning">
          Check warnings: {d.checks.filter((c) => c.severity === 'warn').map((c) => `${c.kind} (${c.items.length})`).join(', ')}. The verdict is unchanged.
        </Callout>
      )}
      {d.checks.some((c) => c.severity === 'fail') && (
        <Callout tone="danger">
          Failed checks: {d.checks.filter((c) => c.severity === 'fail').map((c) => `${c.kind} (${c.items.filter((i) => i.severity === 'fail').length})`).join(', ')}.
        </Callout>
      )}

      {expected !== undefined && actual !== undefined && <ExpectedActual expected={expected} actual={actual} />}

      {assertions.length > 0 && (
        <ul aria-label="Assertions" className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
          {assertions.map(({ a, step }, i) => {
            const v = VERDICT_TEXT[a.verdict] ?? { label: a.verdict, cls: '' };
            const model = [...step.decisions].reverse().find((x) => x.model)?.model;
            return (
              <li key={`${step.stepIndex}-${i}`} className="flex flex-wrap items-center gap-2.5 rounded-control border border-divider px-3 py-2.5">
                {a.assertion === 'ai' ? (
                  <>
                    <Tag tone="ai">AI check</Tag>
                    {a.probability !== undefined && (
                      <span>
                        P(expected result is true) = <span className="font-mono">{a.probability.toFixed(2)}</span>
                      </span>
                    )}
                    <span className={cn('font-semibold', v.cls)}>{v.label}</span>
                    <span className="text-secondary">{[model, a.message].filter(Boolean).join(' · ')}</span>
                  </>
                ) : (
                  <>
                    <Tag mono className="bg-surface-muted">{a.message ?? a.assertion}</Tag>
                    <span className={cn('font-semibold', v.cls)}>{v.label}</span>
                    <span className="text-secondary">deterministic</span>
                  </>
                )}
                <span className="text-xs text-muted">step {step.stepIndex + 1}</span>
              </li>
            );
          })}
        </ul>
      )}

      {timeline.length > 0 && <ScreenshotTimeline steps={timeline} />}

      <Evidence data={d} />

      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        resultId={resultId}
        current={verdict}
        onDone={() => {
          setOverrideOpen(false);
          void query.refetch();
          onChanged();
        }}
      />
    </section>
  );
}

/* ---------------------------------------------------------------- override */

function OverrideDialog({
  open,
  onOpenChange,
  resultId,
  current,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resultId: string;
  current: string;
  onDone: () => void;
}) {
  const [verdict, setVerdict] = useState('');
  const [note, setNote] = useState('');
  const mutation = trpc.results.overrideVerdict.useMutation({ onSuccess: onDone });
  const options = OVERRIDE_VERDICTS.filter(([v]) => v !== current);
  const chosen = verdict === '' ? (options[0]?.[0] ?? '') : verdict;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Override verdict"
      description="Replaces the verdict of this result. The change is recorded for calibration of the decision model."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={mutation.isPending || chosen === ''}
            onClick={() => mutation.mutate({ resultId, verdict: chosen as (typeof OVERRIDE_VERDICTS)[number][0], note })}
          >
            Save override
          </Button>
        </>
      }
    >
      <Field label="New verdict">
        {(id) => (
          <Select id={id} value={chosen} onChange={(e) => setVerdict(e.target.value)}>
            {options.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Note" hint="Why is the automatic verdict wrong?">
        {(id) => <Textarea id={id} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      {mutation.isError && <Callout tone="danger">{errorMessage(mutation.error)}</Callout>}
    </Dialog>
  );
}

/* ---------------------------------------------------------------- evidence tabs */

function Evidence({ data }: { data: ResultDetailData }) {
  const [tab, setTab] = useState<EvidenceTab>('decisions');
  const a11y = data.checks.find((c) => c.kind === 'a11y');
  const consoleCheck = data.checks.find((c) => c.kind === 'console');
  const networkCheck = data.checks.find((c) => c.kind === 'network');
  const tabs: Array<{ id: EvidenceTab; label: string }> = [
    { id: 'decisions', label: 'Decisions' },
    { id: 'video', label: 'Video' },
    { id: 'trace', label: 'Playwright trace' },
    { id: 'console', label: `Console · ${data.console.length}` },
    { id: 'network', label: `Network · ${data.network.length}` },
    { id: 'a11y', label: a11y ? `Accessibility · ${a11y.items.length}` : 'Accessibility' },
  ];
  const move = (dir: number, i: number): void => {
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    if (next) {
      setTab(next.id);
      document.getElementById(`evidence-tab-${next.id}`)?.focus();
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="Evidence" className="flex flex-wrap border-b border-line">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            id={`evidence-tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls="evidence-panel"
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') move(1, i);
              else if (e.key === 'ArrowLeft') move(-1, i);
            }}
            className={cn(
              '-mb-px min-h-[44px] border-b-2 px-3.5 py-2.5 text-sm',
              tab === t.id ? 'border-ink font-semibold text-fg' : 'border-transparent text-secondary',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="evidence-panel" role="tabpanel" aria-labelledby={`evidence-tab-${tab}`}>
        {tab === 'decisions' && <Decisions steps={data.steps} />}
        {tab === 'video' &&
          (data.video ? (
            <video controls preload="metadata" src={artifactUrl(data.video.artifactId)} className="w-full max-w-[720px] rounded-control border border-line">
              <track kind="captions" />
            </video>
          ) : (
            <Empty>No video was recorded for this result.</Empty>
          ))}
        {tab === 'trace' && <Trace trace={data.trace} />}
        {tab === 'console' && <Flagged check={consoleCheck} what="console errors" />}
        {tab === 'console' &&
          (data.console.length === 0 ? (
            <Empty>No console messages.</Empty>
          ) : (
            <div className="flex max-h-72 flex-col gap-1 overflow-auto rounded-control bg-surface-subtle p-3 font-mono text-xs">
              {data.console.map((c, i) => (
                <div key={i} className={cn('break-words', (c.type === 'error' || c.type === 'pageerror') && 'text-danger')}>
                  [{c.type}] {c.text}
                  {c.location ? ` (${c.location})` : ''}
                </div>
              ))}
            </div>
          ))}
        {tab === 'network' && <Flagged check={networkCheck} what="failing requests" />}
        {tab === 'network' &&
          (data.network.length === 0 ? (
            <Empty>No network requests were captured.</Empty>
          ) : (
            <div className="max-h-72 overflow-auto rounded-control border border-line">
              <table className="w-full border-collapse text-left text-xs">
                <thead className="sticky top-0 bg-surface-subtle">
                  <tr>
                    <th scope="col" className="px-2.5 py-2 font-semibold">Method</th>
                    <th scope="col" className="px-2.5 py-2 font-semibold">Status</th>
                    <th scope="col" className="px-2.5 py-2 font-semibold">URL</th>
                    <th scope="col" className="px-2.5 py-2 font-semibold">Time</th>
                    <th scope="col" className="px-2.5 py-2 font-semibold">Type</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {data.network.map((n, i) => (
                    <tr key={i} className="border-t border-divider-row align-top">
                      <td className="px-2.5 py-1.5">{n.method}</td>
                      <td className={cn('px-2.5 py-1.5', n.status !== null && n.status >= 400 && 'text-danger')}>{n.status ?? '–'}</td>
                      <td className="break-all px-2.5 py-1.5">{n.url}</td>
                      <td className="whitespace-nowrap px-2.5 py-1.5">{formatMs(n.durationMs)}</td>
                      <td className="px-2.5 py-1.5">{n.resourceType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        {tab === 'a11y' && <A11yFindings check={a11y} />}
      </div>
    </div>
  );
}

/** Items flagged by the console / network health check, above the raw log. */
function Flagged({ check, what }: { check: CheckResultData | undefined; what: string }) {
  if (!check || check.items.length === 0) return null;
  const failing = check.severity === 'fail';
  return (
    <Callout tone={failing ? 'danger' : 'warning'}>
      <strong>
        {check.items.length} {what} {failing ? 'failed this case' : 'flagged (warning)'}
      </strong>
      <ul aria-label={`Flagged ${what}`} className="m-0 mt-1.5 list-disc pl-5 font-mono text-xs">
        {check.items.map((item, i) => (
          <li key={i} className="break-words">
            {item.summary}
            {item.stepIndex !== undefined ? ` (step ${item.stepIndex + 1})` : ''}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/** Violations found by the axe scan: rule, impact, target selector and help link. */
function A11yFindings({ check }: { check: CheckResultData | undefined }) {
  if (!check) return <Empty>The accessibility scan was not enabled for this run (turn on "Accessibility scan" in the plan checks).</Empty>;
  if (check.items.length === 0) return <Empty>No accessibility violations were found.</Empty>;
  return (
    <ul aria-label="Accessibility violations" className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
      {check.items.map((item, i) => (
        <li key={i} className="flex flex-col gap-1 rounded-control border border-divider px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Tag tone={item.severity === 'fail' ? 'danger' : 'warning'}>{item.severity === 'fail' ? 'fails' : 'warning'}</Tag>
            <Tag mono>{item.ruleId}</Tag>
            <span className="font-semibold">{item.impact}</span>
            <span>{item.summary}</span>
            {item.stepIndex !== undefined && <span className="text-xs text-muted">after step {item.stepIndex + 1}</span>}
          </div>
          <code className="break-all font-mono text-xs text-secondary">{item.target}</code>
          {item.helpUrl && (
            <a href={item.helpUrl} target="_blank" rel="noreferrer" className="text-xs text-primary-text">
              How to fix
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

function Empty({ children }: { children: string }) {
  return <p className="m-0 rounded-control border border-dashed border-line-dashed p-4 text-sm text-secondary">{children}</p>;
}

function Trace({ trace }: { trace: ResultDetailData['trace'] }) {
  if (!trace) return <Empty>No Playwright trace was recorded for this result.</Empty>;
  const url = `${window.location.origin}${artifactUrl(trace.artifactId)}`;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <Callout tone="warning">
        Trace files contain DOM snapshots and screenshots that are <strong>not masked for secrets</strong>. Treat the download as sensitive and do not share it.
      </Callout>
      <div>
        <LinkButton href={artifactUrl(trace.artifactId)} download variant="secondary">
          Download trace.zip
        </LinkButton>
      </div>
      <div>
        <div className="mb-1 font-semibold">Open in the trace viewer</div>
        <p className="m-0 text-secondary">Run one of these in a terminal:</p>
        <pre className="m-0 mt-1.5 overflow-auto rounded-control bg-surface-subtle p-3 font-mono text-xs">
          {`npx playwright show-trace <downloaded trace.zip>\nnpx playwright show-trace ${url}`}
        </pre>
      </div>
    </div>
  );
}

function Decisions({ steps }: { steps: DetailStep[] }) {
  const rows = steps.filter((s) => s.decisions.length > 0 || s.actionTaken);
  if (rows.length === 0) return <Empty>No decisions were recorded (replayed steps need no model call).</Empty>;
  return (
    <div className="flex flex-col gap-1.5 rounded-control bg-surface-subtle p-3 font-mono text-xs text-strong-2">
      {rows.map((s) => (
        <div key={s.stepIndex} className="flex flex-col gap-1">
          <div className="break-words">
            step {s.stepIndex + 1} · {s.actionTaken ?? s.action}
            {s.mode ? ` · ${s.mode}` : ''} · {s.status}
          </div>
          {s.decisions.map((dec, i) => {
            const entries = Object.entries(dec.probabilities).sort((a, b) => b[1] - a[1]);
            return (
              <details key={i} className="ml-3">
                <summary className="min-h-[24px] cursor-pointer break-words">
                  {dec.questionId} → {dec.chosen ?? '–'} · conf {dec.confidence.toFixed(2)} · {dec.model} · {formatMs(dec.latencyMs)}
                  {dec.escalatedTo ? ` · escalated to ${dec.escalatedTo}` : ''}
                </summary>
                <div className="mt-1.5 flex flex-col gap-2 pb-2">
                  {entries.map(([id, p], n) => (
                    <ProbabilityBar key={id} label={id} value={p} top={n === 0} />
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      ))}
    </div>
  );
}
