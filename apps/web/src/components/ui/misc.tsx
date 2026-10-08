import { Link } from '@tanstack/react-router';
import { Fragment, type HTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface BreadcrumbItem {
  label: ReactNode;
  /** In-app route; omit for the current page. */
  to?: string;
}

/** 13 px muted trail with `/` separators; links use the primary text colour. */
export function Breadcrumb({ items, className }: { items: BreadcrumbItem[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={cn('text-[13px] text-muted', className)}>
      <ol className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0">
        {items.map((item, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <li aria-hidden="true" className="select-none">
                /
              </li>
            )}
            <li aria-current={i === items.length - 1 ? 'page' : undefined}>
              {item.to !== undefined ? (
                <Link to={item.to as never} className="text-primary-text no-underline hover:text-primary-text-hover hover:underline">
                  {item.label}
                </Link>
              ) : (
                item.label
              )}
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}

/** Dashed box with secondary text and one action. */
export function EmptyState({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-start gap-3 rounded-control border border-dashed border-line-dashed bg-transparent p-5 text-sm text-secondary',
        className,
      )}
    >
      <div>{children}</div>
      {action}
    </div>
  );
}

/** Loading placeholder block; size it with `className` (e.g. `h-4 w-32`). */
export function Skeleton({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" data-skeleton="" className={cn('rounded-block bg-surface-muted', className)} {...rest} />;
}
