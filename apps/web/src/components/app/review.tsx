import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { StatusPill } from '@/components/ui';
import { cn } from '@/lib/cn';

/* ---------------------------------------------------------------- DiffLine */

/** `code` block of one locator line: removed = danger tint with `−`, added = success tint with `+`. */
export function DiffLine({ kind, children }: { kind: 'removed' | 'added'; children: ReactNode }) {
  return (
    <code
      data-diff={kind}
      className={cn(
        'block whitespace-pre-wrap break-all rounded-tag px-2.5 py-2 font-mono text-xs',
        kind === 'removed' ? 'bg-danger-soft text-danger-ink' : 'bg-success-soft text-success-strong',
      )}
    >
      <span aria-hidden="true">{kind === 'removed' ? '−' : '+'} </span>
      <span className="sr-only">{kind === 'removed' ? 'Removed: ' : 'Added: '}</span>
      {children}
    </code>
  );
}

/* ---------------------------------------------------------------- ReviewListItem */

export interface ReviewListItemProps {
  title: string;
  /** `Shared step “Checkout as guest” · used by 6 cases · conf 0.62`. */
  meta: string;
  selected?: boolean;
  /** Decided items show their outcome as a pill. */
  resolved?: 'approved' | 'rejected';
  to: string;
  search: Record<string, string>;
}

/** Row of the review list: bold title, 12 px meta; selected = `--surface-selected` + `aria-current="true"`. */
export function ReviewListItem({ title, meta, selected = false, resolved, to, search }: ReviewListItemProps) {
  return (
    <Link
      to={to as never}
      search={search as never}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex min-h-[44px] items-start justify-between gap-2.5 border-t border-divider-row px-4 py-3.5 text-sm text-fg no-underline first:border-t-0',
        selected ? 'border-l-[3px] border-l-primary bg-surface-selected' : 'border-l-[3px] border-l-transparent',
      )}
    >
      <span className="flex min-w-0 flex-col gap-1">
        <strong className="break-words font-semibold">{title}</strong>
        <span className="break-words text-xs text-secondary">{meta}</span>
      </span>
      {resolved && (
        <StatusPill status={resolved === 'approved' ? 'passed' : 'failed'} label={resolved === 'approved' ? 'Approved' : 'Rejected'} className="shrink-0" />
      )}
    </Link>
  );
}
