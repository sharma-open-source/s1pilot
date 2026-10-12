import type { RunControlMessage } from '@s1pilot/domain';
import { useEffect, useMemo, useState } from 'react';

import { approveMessage, buildDecisionView, isTerminal, progressCounts, stepMode, type LiveRunState } from './model';
import { useRunSocket } from './useRunSocket';

import {
  BrowserFrame,
  DecisionPanel,
  ElementBoxOverlay,
  EventLog,
  RunProgressBar,
  StepStatusList,
  type StepStatusItem,
} from '@/components/app/live';
import { Breadcrumb, Button, Callout, ConfirmDialog, LinkButton, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { trpc } from '@/lib/trpc';


const BROWSER_LABEL: Record<string, string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };
const NETWORK_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s|^network\b|\b[1-5]\d\d\b.*https?:\/\//i;

interface LiveRunPageProps {
  projectKey: string;
  runId: string;
}

/** Live run view (`/p/:key/runs/:runId/live`): steps, screencast with element boxes, S1 decision panel, event log. */
export function LiveRunPage({ projectKey, runId }: LiveRunPageProps) {
  const { state, frame, connection, send } = useRunSocket(runId);
  const utils = trpc.useUtils();
  const runQuery = trpc.runs.get.useQuery(runId, { refetchInterval: (q) => (isTerminal(q.state.data?.status) ? false : 3000) });
  const caseKey = state.currentCase?.caseKey ?? runQuery.data?.results.at(-1)?.key;
  const caseQuery = trpc.cases.get.useQuery({ key: caseKey ?? '' }, { enabled: caseKey !== undefined && caseKey !== '' });
  const controlMutation = trpc.runs.control.useMutation();
  const cancelMutation = trpc.runs.cancel.useMutation();

  const [showBoxes, setShowBoxes] = useState(true);
  const [drawer, setDrawer] = useState<null | 'console' | 'network'>(null);
  const [takenOver, setTakenOver] = useState(false);
  const [paused, setPaused] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Restore the paused flag from the snapshot after a reload.
  useEffect(() => {
    if (state.ready) setPaused(state.run?.status === 'paused');
  }, [state.ready, state.run?.status]);

  // Keep the counts and queue fresh as cases finish.
  const finishedCases = state.log.filter((l) => l.text.includes(' finished · ')).length;
  useEffect(() => {
    if (finishedCases > 0 || state.finished) void utils.runs.get.invalidate(runId);
  }, [finishedCases, state.finished, runId, utils]);

  const control = (message: RunControlMessage): void => {
    setActionError(null);
    if (send(message)) return;
    controlMutation.mutate(
      { runId, message },
      { onError: (err) => setActionError(errorMessage(err)) },
    );
  };

  const decision = useMemo(() => buildDecisionView(state), [state]);
  const data = runQuery.data;
  const counts = progressCounts(data?.results ?? [], data?.progress.total ?? state.totalCases ?? 0);
  const status = state.finished?.status ?? state.run?.status ?? data?.status;
  const finished = state.finished !== null || isTerminal(data?.status);
  const runMode = data?.config?.mode;
  const shortId = runId.slice(-6);
  const currentTitle = caseQuery.data?.title;
  const casesDone = counts.passed + counts.failed + counts.review;
  const caseNo = Math.min(Math.max(counts.total, 1), casesDone + (state.currentCase && !finished ? 1 : 0));

  const steps = buildStepItems(state, caseQuery.data?.steps.map((s) => s.action), runMode);
  const upNext = (data?.jobs ?? []).filter((j) => j.status === 'queued' && j.caseKey !== undefined && j.caseKey !== caseKey);

  const viewport = frame ?? null;
  const vw = frame?.width ?? 1280;
  const vh = frame?.height ?? 720;
  const interactive = state.elements.length;

  const meta = [
    data?.config?.environment,
    data?.config?.browser !== undefined ? (BROWSER_LABEL[data.config.browser] ?? data.config.browser) : undefined,
    counts.total > 0 ? `case ${caseNo} of ${counts.total}` : undefined,
  ].filter((x): x is string => x !== undefined && x !== '');

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Breadcrumb
        items={[
          { label: 'Runs', to: `/p/${encodeURIComponent(projectKey)}/runs` },
          { label: `Run #${shortId}` },
        ]}
      />

      {connection !== 'open' && !finished && (
        <Callout tone="warning" role="status">
          {connection === 'connecting' ? 'Connecting to the run…' : 'Connection lost. Reconnecting…'}
        </Callout>
      )}

      <header className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-line bg-surface px-[18px] py-3.5">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className={cn('h-2.5 w-2.5 shrink-0 rounded-full', finished ? (status === 'passed' ? 'bg-success' : 'bg-danger') : paused ? 'bg-warning-bar' : 'bg-primary')}
            />
            <h1 className="m-0 min-w-0 break-words text-xl font-semibold">
              {caseKey !== undefined ? `${caseKey} · run #${shortId}` : `Run #${shortId}`}
            </h1>
            <span className="sr-only">{finished ? `Status: ${status ?? 'finished'}` : paused ? 'Status: paused' : 'Status: running'}</span>
          </div>
          <div className="text-[13px] text-secondary">
            {currentTitle !== undefined && <span>{currentTitle}</span>}
            {currentTitle !== undefined && meta.length > 0 && ' · '}
            {meta.join(' · ')}
          </div>
        </div>
        <div className="flex min-w-[220px] max-w-[360px] flex-[1_1_220px] flex-col">
          {runQuery.isLoading ? <Skeleton className="h-10 w-full" /> : <RunProgressBar counts={counts} />}
        </div>
        <div className="flex gap-2">
          <Button
            disabled={finished}
            onClick={() => {
              control({ type: paused ? 'resume' : 'pause' });
              setPaused(!paused);
            }}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button variant="danger-outline" disabled={finished} onClick={() => setConfirmAbort(true)}>
            Abort
          </Button>
        </div>
      </header>

      {actionError !== null && <Callout tone="danger">{actionError}</Callout>}

      {finished && (
        <Callout tone={status === 'passed' ? 'success' : status === 'cancelled' || status === 'aborted' ? 'warning' : 'danger'} className="flex flex-wrap items-center justify-between gap-3">
          <span role="status">
            Run finished: <strong>{status}</strong>
            {state.finished !== null && ` · ${state.finished.summary.passed} passed, ${state.finished.summary.failed} failed, ${state.finished.summary.needsReview} to review`}
          </span>
          <LinkButton to={`/p/${encodeURIComponent(projectKey)}/runs/${encodeURIComponent(runId)}`} variant="secondary" size="sm">
            Open report
          </LinkButton>
        </Callout>
      )}

      <div className="flex flex-wrap items-start gap-4">
        <section
          aria-label="Steps of current case"
          className="flex min-w-0 flex-[1_1_220px] max-w-[270px] flex-col gap-1.5 rounded-card border border-line bg-surface p-3.5 max-[1100px]:max-w-none"
        >
          <div className="text-sm font-semibold">{caseKey ?? 'Waiting for a case'}</div>
          {currentTitle !== undefined && <div className="mb-1.5 text-[13px] text-secondary">{currentTitle}</div>}
          {steps.length === 0 ? (
            <p className="m-0 text-[13px] text-secondary">{state.ready ? 'No step has started yet.' : 'Loading steps…'}</p>
          ) : (
            <StepStatusList steps={steps} />
          )}
          <div className="mt-2.5 border-t border-divider-row pt-2.5 text-[13px] font-semibold">Up next</div>
          {upNext.length === 0 ? (
            <div className="text-[13px] text-secondary">Nothing queued.</div>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px] text-secondary">
              {upNext.map((j) => (
                <li key={j.id} className="font-mono">
                  {j.caseKey}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-3">
          <BrowserFrame
            url={state.url}
            frame={viewport}
            overlay={
              showBoxes && state.elements.length > 0 ? (
                <>
                  <ElementBoxOverlay elements={state.elements} chosenId={state.chosenId} width={vw} height={vh} />
                  <div className="absolute bottom-[6%] left-[3%] rounded-tag bg-ink px-2.5 py-1.5 text-xs text-ink-text">
                    {interactive} interactive elements · numbered boxes shown
                  </div>
                </>
              ) : null
            }
            toolbar={
              <>
                <Button
                  size="sm"
                  aria-pressed={takenOver}
                  onClick={() => {
                    control({ type: takenOver ? 'release' : 'takeover' });
                    setTakenOver(!takenOver);
                  }}
                  disabled={finished}
                >
                  {takenOver ? 'Release control' : 'Take over browser'}
                </Button>
                <Button size="sm" aria-pressed={showBoxes} onClick={() => setShowBoxes(!showBoxes)}>
                  Toggle element boxes
                </Button>
                <Button size="sm" aria-expanded={drawer !== null} onClick={() => setDrawer(drawer === null ? 'console' : null)}>
                  Console · Network
                </Button>
              </>
            }
          />
          {drawer !== null && <ConsoleDrawer state={state} tab={drawer} onTab={setDrawer} onClose={() => setDrawer(null)} />}
        </div>

        <div className="flex min-w-0 flex-[1_1_300px] max-w-[380px] flex-col max-[1100px]:max-w-none">
          <DecisionPanel
            step={decision?.step ?? null}
            model={decision?.model ?? null}
            latencyMs={decision?.latencyMs ?? null}
            question={decision?.question ?? null}
            rows={decision?.rows ?? []}
            allOptions={decision?.allOptions ?? []}
            callout={decision?.callout ?? null}
            actions={
              decision?.escalationId != null
                ? {
                    approveId: decision.approveId,
                    onApprove: (choice, save) => control(approveMessage(decision.escalationId as string, choice, save)),
                    onPick: (choice) => control({ type: 'pickOther', escalationId: decision.escalationId as string, choice }),
                    onSkip: () => control({ type: 'skipStep' }),
                  }
                : undefined
            }
          />
        </div>
      </div>

      <EventLog lines={state.log} />

      <ConfirmDialog
        open={confirmAbort}
        onOpenChange={setConfirmAbort}
        tone="danger"
        title="Abort this run?"
        description="The browser closes and unfinished cases are cancelled."
        confirmLabel="Abort run"
        onConfirm={() => {
          setConfirmAbort(false);
          cancelMutation.mutate(runId, { onError: (err) => setActionError(errorMessage(err)) });
        }}
      />
    </div>
  );
}

/** Rows for the step list: started steps from the socket, remaining ones from the case definition. */
function buildStepItems(state: LiveRunState, definition: string[] | undefined, runMode: string | undefined): StepStatusItem[] {
  const byIndex = new Map(state.steps.map((s) => [s.index, s]));
  const total = Math.max(definition?.length ?? 0, ...(state.steps.map((s) => s.index + 1)), 0);
  const items: StepStatusItem[] = [];
  for (let i = 0; i < total; i += 1) {
    const live = byIndex.get(i);
    const title = live?.action || definition?.[i] || `Step ${i + 1}`;
    if (live === undefined) {
      items.push({ index: i, title, status: 'pending' });
    } else {
      items.push({ index: i, title, status: live.status, suffix: stepMode(live, runMode, state.currentCase?.mode) });
    }
  }
  return items;
}

function ConsoleDrawer({
  state,
  tab,
  onTab,
  onClose,
}: {
  state: LiveRunState;
  tab: 'console' | 'network';
  onTab: (tab: 'console' | 'network') => void;
  onClose: () => void;
}) {
  const logs = state.log.filter((l) => l.message !== undefined);
  const lines = logs.filter((l) => (tab === 'network') === NETWORK_RE.test(l.message ?? ''));
  return (
    <section aria-label="Console and network" className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Drawer tab" className="flex gap-2">
          <Button size="sm" aria-pressed={tab === 'console'} onClick={() => onTab('console')}>
            Console
          </Button>
          <Button size="sm" aria-pressed={tab === 'network'} onClick={() => onTab('network')}>
            Network
          </Button>
        </div>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      <div role="log" aria-label={tab === 'console' ? 'Console output' : 'Network requests'} className="max-h-48 overflow-auto font-mono text-xs">
        {lines.length === 0 ? (
          <div className="text-secondary">{tab === 'console' ? 'No console messages yet.' : 'No network requests yet.'}</div>
        ) : (
          lines.map((l) => (
            <div key={l.id} className={cn('break-words', (l.level === 'error' || l.level === 'warn') && 'text-danger')}>
              [{l.time}] {l.message}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
