import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';

import { Dialog, StatusPill, Tag } from '@/components/ui';
import { cn } from '@/lib/cn';

/* ---------------------------------------------------------------- ResultListItem */

export interface ResultListItemProps {
  /** Case key, mono (`SHOP-TC-44`). */
  resultKey: string;
  title: string;
  /** `staging · WebKit · step 3`. */
  meta: string;
  /** Verdict, mapped through `StatusPill`. */
  status: string;
  selected?: boolean;
  /** Number of warning checks (a11y / console / network); shows a warning pill next to the status. */
  warnings?: number;
  /** Router path of the list route. */
  to: string;
  /** Search params of the target (keeps `filter`, sets `result`). */
  search: Record<string, string>;
}

/** Master-list row of the run report: key, title, `env · browser · step n` and a status pill. */
export function ResultListItem({ resultKey, title, meta, status, selected = false, warnings = 0, to, search }: ResultListItemProps) {
  return (
    <Link
      to={to as never}
      search={search as never}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex min-h-[44px] items-stretch justify-between gap-2.5 border-t border-divider-row px-3.5 py-3 text-sm text-fg no-underline first:border-t-0',
        selected ? 'border-l-[3px] border-l-primary bg-surface-selected' : 'border-l-[3px] border-l-transparent',
      )}
    >
      <span className="min-w-0">
        <span className="block break-all font-mono text-xs text-secondary">{resultKey}</span>
        <strong className="block font-semibold">{title}</strong>
        <span className="block text-xs text-secondary">{meta}</span>
      </span>
      <span className="flex flex-col items-end justify-center gap-1">
        <StatusPill status={status} />
        {warnings > 0 && <Tag tone="warning">{warnings === 1 ? '1 warning' : `${warnings} warnings`}</Tag>}
      </span>
    </Link>
  );
}

/* ---------------------------------------------------------------- ExpectedActual */

/** Two boxes: what the case expected (neutral) and what happened (danger tint). */
export function ExpectedActual({ expected, actual }: { expected: ReactNode; actual: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3.5">
      <div className="flex flex-col gap-1.5 rounded-control bg-surface-subtle p-3">
        <span className="text-xs uppercase tracking-[0.05em] text-muted">Expected</span>
        <span className="break-words text-sm">{expected}</span>
      </div>
      <div className="flex flex-col gap-1.5 rounded-control bg-danger-soft p-3">
        <span className="text-xs uppercase tracking-[0.05em] text-danger-strong">Actual</span>
        <span className="break-words text-sm text-danger-ink">{actual}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- ScreenshotTimeline */

export interface TimelineStep {
  index: number;
  /** `Add item`. */
  title: string;
  /** Suffix after the title: `✓ replay`, `✗`, `not run`. */
  suffix: string;
  state: 'passed' | 'failed' | 'not-run';
  /** Screenshot URL; absent for steps without one. */
  src?: string;
}

/** Strip of per-step screenshots; clicking one opens a lightbox. The failing step has a danger border. */
export function ScreenshotTimeline({ steps }: { steps: TimelineStep[] }) {
  const [open, setOpen] = useState<TimelineStep | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-sm font-semibold">Step timeline</h3>
      <ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 p-0">
        {steps.map((s) => {
          const caption = `${s.index + 1} · ${s.title} · ${s.suffix}`;
          const frame = cn(
            'flex h-24 w-full items-center justify-center overflow-hidden rounded-tag',
            s.state === 'failed' && 'border-2 border-danger bg-danger-soft',
            s.state === 'passed' && 'border border-line hatch',
            s.state === 'not-run' && 'border border-dashed border-line-dashed',
          );
          return (
            <li key={s.index}>
              <figure className="m-0 flex flex-col gap-1.5">
                {s.src !== undefined ? (
                  <button type="button" onClick={() => setOpen(s)} aria-label={`Open screenshot of step ${s.index + 1}`} className={cn(frame, 'cursor-zoom-in p-0')}>
                    <img src={s.src} alt={`Screenshot after step ${s.index + 1}: ${s.title}`} loading="lazy" className="h-full w-full object-cover object-top" />
                  </button>
                ) : (
                  <div className={frame} aria-hidden="true" />
                )}
                <figcaption className={cn('break-words text-xs', s.state === 'failed' ? 'font-semibold text-danger' : s.state === 'not-run' ? 'text-muted' : 'text-secondary')}>
                  {caption}
                </figcaption>
              </figure>
            </li>
          );
        })}
      </ol>
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)} title={open ? `Step ${open.index + 1} · ${open.title}` : 'Screenshot'}>
        {open?.src !== undefined && <img src={open.src} alt={`Screenshot after step ${open.index + 1}`} className="max-h-[70vh] w-full rounded-tag border border-line object-contain" />}
      </Dialog>
    </div>
  );
}
