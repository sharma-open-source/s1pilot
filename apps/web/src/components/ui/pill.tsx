import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

/** Visual treatment of a pill (design.md 2.2). */
export type PillTone = 'running' | 'success' | 'danger' | 'warning' | 'flaky' | 'neutral' | 'draft' | 'queued';

const toneClass: Record<PillTone, string> = {
  running: 'bg-primary-soft text-primary-text',
  success: 'bg-success-soft text-success',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  flaky: 'bg-flaky-soft text-flaky',
  neutral: 'bg-surface-muted text-strong-2',
  draft: 'border border-dashed border-line-dashed-strong bg-transparent text-secondary',
  queued: 'border border-line-input bg-transparent text-secondary',
};

/** Rounded status chip, 12/600. Prefer `StatusPill` for domain statuses. */
export function Pill({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: PillTone }) {
  return (
    <span
      className={cn('inline-flex items-center rounded-pill px-2.5 py-[3px] text-xs font-semibold', toneClass[tone], className)}
      {...rest}
    />
  );
}

interface StatusDef {
  label: string;
  tone: PillTone;
}

/** Single source of the status to pill mapping (design.md 2.2). */
export const STATUS_PILLS = {
  running: { label: 'Running', tone: 'running' },
  'in-progress': { label: 'In progress', tone: 'running' },
  passed: { label: 'Passed', tone: 'success' },
  valid: { label: 'Valid', tone: 'success' },
  connected: { label: 'Connected', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  abort: { label: 'Failed', tone: 'danger' },
  critical: { label: 'Failed', tone: 'danger' },
  'needs-review': { label: 'Review', tone: 'warning' },
  'heal-pending': { label: 'Review', tone: 'warning' },
  expired: { label: 'Review', tone: 'warning' },
  flaky: { label: 'Flaky', tone: 'flaky' },
  blocked: { label: 'Blocked', tone: 'neutral' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  'not-run': { label: 'Blocked', tone: 'neutral' },
  draft: { label: 'Draft', tone: 'draft' },
  queued: { label: 'Queued', tone: 'queued' },
  'to-do': { label: 'To do', tone: 'queued' },
} as const satisfies Record<string, StatusDef>;

export type Status = keyof typeof STATUS_PILLS;

/** Maps a domain status to its pill label and tone; unknown statuses fall back to a neutral pill with the raw text. */
export function statusPillFor(status: string): StatusDef {
  return (STATUS_PILLS as Record<string, StatusDef>)[status] ?? { label: status, tone: 'neutral' };
}

/** Status chip: always text plus colour. */
export function StatusPill({ status, label, className }: { status: Status | (string & {}); label?: string; className?: string }) {
  const def = statusPillFor(status);
  return (
    <Pill tone={def.tone} data-status={status} className={className}>
      {label ?? def.label}
    </Pill>
  );
}

export type TagTone = 'neutral' | 'danger' | 'warning' | 'ai' | 'primary';

const tagClass: Record<TagTone, string> = {
  neutral: 'border border-divider bg-surface-subtle text-strong-2',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  ai: 'bg-ai-soft text-ai',
  primary: 'bg-primary-soft text-primary-text',
};

/** Small 6 px-radius label. Use `mono` for tags and keys. */
export function Tag({
  tone = 'neutral',
  mono,
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: TagTone; mono?: boolean }) {
  return (
    <span
      className={cn('inline-flex items-center rounded-tag px-2 py-0.5 text-xs', tagClass[tone], mono && 'font-mono', className)}
      {...rest}
    />
  );
}
