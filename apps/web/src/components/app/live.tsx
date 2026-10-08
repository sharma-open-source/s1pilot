import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { Button, Callout, Checkbox } from '@/components/ui';
import { cn } from '@/lib/cn';

/* ---------------------------------------------------------------- ProbabilityBar */

/** Label left (mono), value right (mono), 8 px track; fill `--primary` for the top row, `--chart-2` for others. */
export function ProbabilityBar({ label, value, top = false }: { label: string; value: number; top?: boolean }) {
  const width = `${Math.max(0, Math.min(1, value)) * 100}%`;
  return (
    <div className="flex flex-col gap-1" data-testid="probability-bar">
      <div className={cn('flex justify-between gap-2 font-mono text-[13px]', top && 'font-semibold')}>
        <span className="min-w-0 break-words">{label}</span>
        <span>{value.toFixed(2)}</span>
      </div>
      <div className="h-2 rounded-pill bg-track" role="presentation">
        <div className={cn('h-2 rounded-pill', top ? 'bg-primary' : 'bg-chart-2')} style={{ width }} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- RunProgressBar */

export interface ProgressSegments {
  passed: number;
  failed: number;
  review: number;
  queued: number;
}

/** 10 px pill track with passed / failed / review segments and a legend row. */
export function RunProgressBar({ counts }: { counts: ProgressSegments }) {
  const total = counts.passed + counts.failed + counts.review + counts.queued;
  const w = (n: number) => `${total === 0 ? 0 : (n / total) * 100}%`;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className="flex h-2.5 overflow-hidden rounded-pill bg-track"
        role="progressbar"
        aria-label="Run progress"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={total - counts.queued}
      >
        <div className="bg-success" style={{ width: w(counts.passed) }} />
        <div className="bg-danger" style={{ width: w(counts.failed) }} />
        <div className="bg-warning-bar" style={{ width: w(counts.review) }} />
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-0.5 text-xs text-secondary">
        <span>{counts.passed} passed</span>
        <span>{counts.failed} failed</span>
        <span>{counts.review} review</span>
        <span>{counts.queued} queued</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- StepStatusList */

export interface StepStatusItem {
  index: number;
  title: string;
  status: 'passed' | 'failed' | 'running' | 'pending' | 'blocked' | 'skipped';
  /** `replay`, `heal · locator changed`, ... */
  suffix?: string | undefined;
}

const STEP_ICON: Record<StepStatusItem['status'], { glyph: string; cls: string; label: string }> = {
  passed: { glyph: '✓', cls: 'text-success font-semibold', label: 'passed' },
  failed: { glyph: '✗', cls: 'text-danger font-semibold', label: 'failed' },
  blocked: { glyph: '✗', cls: 'text-danger font-semibold', label: 'blocked' },
  skipped: { glyph: '○', cls: 'text-secondary', label: 'skipped' },
  running: { glyph: '●', cls: 'text-warning font-semibold', label: 'in progress' },
  pending: { glyph: '○', cls: 'text-secondary', label: 'pending' },
};

/** Rows with ✓ / ● / ✗ / ○, "N · Short title" and mode suffix; the current row has `--warning-soft` background. */
export function StepStatusList({ steps }: { steps: StepStatusItem[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
      {steps.map((s) => {
        const icon = STEP_ICON[s.status];
        const current = s.status === 'running';
        return (
          <li
            key={s.index}
            aria-current={current ? 'step' : undefined}
            className={cn('flex gap-2 rounded-tag p-2', current && 'bg-warning-soft', s.status === 'pending' && 'text-secondary')}
          >
            <span className={icon.cls} aria-hidden="true">
              {icon.glyph}
            </span>
            <span className="sr-only">{icon.label}</span>
            <span className="min-w-0 break-words">
              <span className={cn(current && 'font-semibold')}>
                {s.index + 1} · {s.title}
              </span>
              {s.suffix !== undefined && s.suffix !== '' && (
                <span className={cn(current ? 'block text-warning-strong' : 'text-secondary')}>
                  {current ? s.suffix : ` · ${s.suffix}`}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------------------------------------------------------- ElementBoxOverlay + BrowserFrame */

export interface OverlayBox {
  id: string;
  label: string;
  box: { x: number; y: number; w: number; h: number };
}

/**
 * Numbered boxes over the screencast. Boxes are positioned in percentages of the viewport size, so they stay
 * aligned with the frame at any panel width. Chosen = 3 px solid primary, candidates = 2 px dashed muted.
 */
export function ElementBoxOverlay({
  elements,
  chosenId,
  width,
  height,
}: {
  elements: OverlayBox[];
  chosenId: string | null;
  width: number;
  height: number;
}) {
  if (width <= 0 || height <= 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0" data-testid="element-overlay">
      {elements.map((el) => {
        const chosen = el.id === chosenId;
        return (
          <div
            key={el.id}
            data-element={el.id}
            data-chosen={chosen ? 'true' : undefined}
            className={cn(
              'absolute box-border flex items-center justify-center overflow-hidden rounded-tag px-1 text-center text-xs leading-tight',
              chosen
                ? 'z-10 border-[3px] border-solid border-primary bg-primary-soft font-semibold text-primary-text'
                : 'border-2 border-dashed border-muted text-strong-2',
            )}
            style={{
              left: `${(el.box.x / width) * 100}%`,
              top: `${(el.box.y / height) * 100}%`,
              width: `${(el.box.w / width) * 100}%`,
              height: `${(el.box.h / height) * 100}%`,
            }}
          >
            <span className="truncate">
              {el.id} {el.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Browser chrome row, viewport (image or hatch while loading) and a toolbar row. */
export function BrowserFrame({
  url,
  frame,
  overlay,
  toolbar,
  caption,
}: {
  url: string | null;
  frame: { url: string; width: number; height: number } | null;
  overlay?: ReactNode;
  toolbar?: ReactNode;
  caption?: string;
}) {
  return (
    <section aria-label="Browser view" className="flex min-w-0 flex-col overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex items-center gap-2.5 border-b border-divider bg-surface-subtle px-3.5 py-2.5">
        <span className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-line-input" />
          <span className="h-2.5 w-2.5 rounded-full bg-line-input" />
          <span className="h-2.5 w-2.5 rounded-full bg-line-input" />
        </span>
        <span className="min-w-0 flex-1 truncate rounded-tag border border-divider bg-surface px-2.5 py-1.5 font-mono text-xs text-secondary" title={url ?? undefined}>
          {url ?? 'Waiting for the page…'}
        </span>
        <span className="hidden whitespace-nowrap text-xs text-secondary sm:inline">Live · screencast</span>
      </div>
      <div
        className="relative w-full overflow-hidden bg-[repeating-linear-gradient(45deg,var(--surface-hatch-a)_0_12px,var(--surface-hatch-b)_12px_24px)]"
        style={{ aspectRatio: frame ? `${frame.width} / ${frame.height}` : '16 / 9', maxHeight: '70vh' }}
        data-testid="viewport"
      >
        {frame !== null ? (
          <img src={frame.url} alt="Live browser screencast" className="absolute inset-0 h-full w-full select-none object-fill" draggable={false} />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-secondary">{caption ?? 'Waiting for the first frame…'}</div>
        )}
        {overlay}
      </div>
      {toolbar !== undefined && <div className="flex flex-wrap gap-2 border-t border-divider px-3.5 py-2.5 text-[13px]">{toolbar}</div>}
    </section>
  );
}

/* ---------------------------------------------------------------- DecisionPanel */

export interface DecisionPanelOption {
  id: string;
  label: string;
  p: number;
}

export interface DecisionPanelProps {
  step: number | null;
  model: string | null;
  latencyMs: number | null;
  question: string | null;
  rows: DecisionPanelOption[];
  allOptions: DecisionPanelOption[];
  callout: { title: string; body: string } | null;
  /** Present while a human is asked: enables the buttons. */
  actions?: {
    approveId: string | null;
    onApprove: (choice: string, saveToLearned: boolean) => void;
    onPick: (choice: string) => void;
    onSkip: () => void;
  } | undefined;
  /** Shown when there is no decision yet. */
  emptyText?: string;
}

/** Decision · step N: probabilities, threshold callout and approval buttons (keyboard A / P / S). */
export function DecisionPanel(props: DecisionPanelProps) {
  const { step, model, latencyMs, question, rows, allOptions, callout, actions } = props;
  const [picking, setPicking] = useState(false);
  const [save, setSave] = useState(true);
  const hasDecision = step !== null || rows.length > 0;
  const asking = actions !== undefined;

  useEffect(() => {
    if (!asking) setPicking(false);
  }, [asking]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (!actions || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
    const key = e.key.toLowerCase();
    if (key === 'a' && actions.approveId !== null) {
      e.preventDefault();
      actions.onApprove(actions.approveId, save);
    } else if (key === 'p') {
      e.preventDefault();
      setPicking((v) => !v);
    } else if (key === 's') {
      e.preventDefault();
      actions.onSkip();
    }
  };

  return (
    <section
      aria-label="System 1 decision"
      aria-live="polite"
      onKeyDown={onKeyDown}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-line bg-surface p-4 text-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-[15px] font-semibold">{step !== null ? `Decision · step ${step}` : 'Decision'}</h2>
        {model !== null && (
          <span className="font-mono text-xs text-secondary">
            {model}
            {latencyMs !== null ? ` · ${Math.round(latencyMs)} ms` : ''}
          </span>
        )}
      </div>
      {!hasDecision && <p className="m-0 text-[13px] text-secondary">{props.emptyText ?? 'No decision yet. System 1 answers appear here as the run moves.'}</p>}
      {question !== null && <div className="text-[13px] text-secondary">Question: {question}</div>}
      {rows.length > 0 && (
        <div className="flex flex-col gap-2">
          {rows.map((r, i) => (
            <ProbabilityBar key={r.id} label={r.label} value={r.p} top={i === 0} />
          ))}
        </div>
      )}
      {callout !== null && (
        <Callout tone="warning" className="flex flex-col gap-1">
          <strong>{callout.title}</strong>
          <span>{callout.body}</span>
        </Callout>
      )}
      {asking && (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              className="flex-[1_1_140px]"
              disabled={actions.approveId === null}
              aria-keyshortcuts="A"
              onClick={() => actions.approveId !== null && actions.onApprove(actions.approveId, save)}
            >
              {actions.approveId !== null ? `Approve ${actions.approveId}` : 'Approve'}
            </Button>
            <Button className="flex-[1_1_120px]" aria-expanded={picking} aria-keyshortcuts="P" onClick={() => setPicking((v) => !v)}>
              Pick another
            </Button>
            <Button className="flex-[1_1_100px]" aria-keyshortcuts="S" onClick={actions.onSkip}>
              Skip step
            </Button>
          </div>
          {picking && (
            <ul aria-label="All options" className="m-0 flex max-h-56 list-none flex-col gap-1 overflow-auto rounded-control border border-line p-1.5">
              {allOptions.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setPicking(false);
                      actions.onPick(o.id);
                    }}
                    className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-tag border-0 bg-transparent px-2.5 text-left font-mono text-[13px] text-fg hover:bg-surface-subtle"
                  >
                    <span className="min-w-0 break-words">{o.label}</span>
                    <span>{o.p.toFixed(2)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Checkbox label="Save approved choice into learned script" checked={save} onChange={(e) => setSave(e.target.checked)} />
        </>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- EventLog */

export interface EventLogLine {
  id: number;
  time: string;
  text: string;
  warn: boolean;
}

/** `role=log` panel on `--ink`; escalations in `--warning-log`; autoscrolls unless the user scrolled up. */
export function EventLog({ lines, className }: { lines: EventLogLine[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <section aria-label="Event log" className={cn('rounded-card bg-ink px-4 py-3.5 text-ink-text', className)}>
      <div
        ref={ref}
        role="log"
        aria-label="Run events"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="flex max-h-60 flex-col gap-1 overflow-auto font-mono text-xs"
      >
        {lines.length === 0 && <div>Waiting for events…</div>}
        {lines.map((l) => (
          <div key={l.id} className={cn('break-words', l.warn && 'text-warning-log')}>
            [{l.time}] {l.text}
          </div>
        ))}
      </div>
    </section>
  );
}
