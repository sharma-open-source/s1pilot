import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/cn';

/** White panel with a 1 px border and 10 px radius. Pass `aria-label` to make it a labelled section. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  const labelled = rest['aria-label'] !== undefined || rest['aria-labelledby'] !== undefined;
  const Tag = labelled ? 'section' : 'div';
  return <Tag className={cn('rounded-card border border-line bg-surface', className)} {...rest} />;
}

export interface CardHeaderProps {
  title: ReactNode;
  /** Link or button on the right. */
  action?: ReactNode;
  className?: string;
}

/** Title row with a bottom divider (`16px 18px`). */
export function CardHeader({ title, action, className }: CardHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 border-b border-divider px-[18px] py-4', className)}>
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {action}
    </div>
  );
}

/** Subtle inset panel used inside cards. */
export function InsetBox({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-control border border-divider bg-surface-subtle p-3.5', className)} {...rest} />;
}
