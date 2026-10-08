import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/cn';

export type CalloutTone = 'warning' | 'info-ai' | 'danger' | 'success';

const toneClass: Record<CalloutTone, string> = {
  warning: 'bg-warning-soft text-warning-strong',
  'info-ai': 'bg-ai-soft text-ai-strong',
  danger: 'bg-danger-soft text-danger-strong',
  success: 'bg-success-soft text-success-strong',
};

/** Inline message box. Danger callouts use `role="alert"`. */
export function Callout({
  tone = 'warning',
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { tone?: CalloutTone }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'note'}
      className={cn('rounded-control px-3 py-2.5 text-[13px]', toneClass[tone], className)}
      {...rest}
    />
  );
}
